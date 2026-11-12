import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { RunResult } from './types.js';

const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'collab-python-runner';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || (process.platform === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock');
const TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 120000);
const MAX_OUTPUT_BYTES = Number(process.env.RUN_OUTPUT_LIMIT_BYTES || 64 * 1024);

type DockerCreateResponse = {
  Id: string;
};

type DockerWaitResponse = {
  StatusCode: number;
};

export type RunnerFile = {
  name: string;
  content: string;
};

type StopReason = 'timeout' | 'output-limit' | 'stopped';

type RunOptions = {
  signal?: AbortSignal;
};

class OutputCollector {
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private totalBytes = 0;

  append(stream: 'stdout' | 'stderr', chunk: Buffer) {
    const remaining = MAX_OUTPUT_BYTES - this.totalBytes;
    if (remaining <= 0) return false;

    const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    this.totalBytes += accepted.byteLength;
    if (stream === 'stderr') this.stderrChunks.push(accepted);
    else this.stdoutChunks.push(accepted);

    return chunk.byteLength <= remaining;
  }

  getOutput() {
    return {
      stdout: Buffer.concat(this.stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(this.stderrChunks).toString('utf8')
    };
  }
}

function dockerRequest(method: string, path: string, body?: Buffer | object, contentType = 'application/json') {
  const payload = Buffer.isBuffer(body) ? body : body ? Buffer.from(JSON.stringify(body)) : undefined;

  return new Promise<Buffer>((resolve, reject) => {
    const request = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: {
          Host: 'docker',
          ...(payload
            ? {
                'Content-Type': contentType,
                'Content-Length': payload.length
              }
            : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
            return;
          }
          reject(new Error(`Docker API ${method} ${path} failed with ${response.statusCode}: ${data.toString('utf8')}`));
        });
      }
    );

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function attachContainerLogs(containerId: string, output: OutputCollector, onLimitExceeded: () => void) {
  let pending = Buffer.alloc(0);
  let limitExceeded = false;
  let request: http.ClientRequest;

  const finished = new Promise<void>((resolve, reject) => {
    request = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/containers/${containerId}/attach?stream=1&stdout=1&stderr=1`,
        method: 'POST',
        headers: {
          Host: 'docker'
        }
      },
      (response) => {
        response.on('data', (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);

          while (pending.length >= 8) {
            const streamType = pending[0];
            const size = pending.readUInt32BE(4);
            if (pending.length < 8 + size) break;

            const payload = pending.subarray(8, 8 + size);
            pending = pending.subarray(8 + size);

            const stream = streamType === 2 ? 'stderr' : 'stdout';
            if (!output.append(stream, payload) && !limitExceeded) {
              limitExceeded = true;
              onLimitExceeded();
            }
          }
        });
        response.on('end', resolve);
        response.on('close', resolve);
        response.on('error', reject);
      }
    );

    request.on('error', reject);
    request.end();
  });

  return {
    finished,
    close: () => request.destroy()
  };
}

function parseJson<T>(data: Buffer): T {
  return JSON.parse(data.toString('utf8')) as T;
}

function createTarEntry(filename: string, content: string) {
  const fileContent = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);

  header.write(filename, 0, 100);
  header.write('0000644', 100, 8);
  header.write('0000000', 108, 8);
  header.write('0000000', 116, 8);
  header.write(fileContent.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  header.fill(' ', 148, 156);
  header.write('0', 156, 1);
  header.write('ustar', 257, 6);
  header.write('00', 263, 2);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padding = Buffer.alloc((512 - (fileContent.length % 512)) % 512, 0);
  return Buffer.concat([header, fileContent, padding]);
}

function validateArchiveFileName(name: string) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    throw new Error(`Некорректное имя файла: ${name}`);
  }
  if (Buffer.byteLength(name, 'utf8') > 100) {
    throw new Error(`Слишком длинное имя файла для запуска: ${name}`);
  }
}

function createTarArchive(files: RunnerFile[]) {
  const usedNames = new Set<string>();
  const entries = files.map((file) => {
    validateArchiveFileName(file.name);
    if (usedNames.has(file.name)) throw new Error(`Дублирующееся имя файла: ${file.name}`);
    usedNames.add(file.name);
    return createTarEntry(file.name, file.content);
  });

  return Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
}

async function killContainer(id: string) {
  try {
    await dockerRequest('POST', `/containers/${id}/kill`);
  } catch {
    // The container may have exited between timeout detection and kill.
  }
}

async function removeContainer(id: string) {
  try {
    await dockerRequest('DELETE', `/containers/${id}?force=1&v=1`);
  } catch {
    // Best-effort cleanup. The run result is more important than cleanup noise.
  }
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function appendMessage(stderr: string, message: string) {
  return `${stderr}${stderr ? '\n' : ''}${message}`;
}

export async function runPythonFile(entryFileName: string, files: RunnerFile[], options: RunOptions = {}): Promise<RunResult> {
  const containerName = `collab-python-${randomUUID()}`;
  let containerId = '';
  let stopReason: StopReason | null = null;
  const output = new OutputCollector();
  let detachLogs: (() => void) | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let stopListener: (() => void) | null = null;

  const stopContainer = async (reason: StopReason) => {
    if (stopReason) return;
    stopReason = reason;
    if (containerId) await killContainer(containerId);
  };

  try {
    validateArchiveFileName(entryFileName);
    if (!files.some((file) => file.name === entryFileName)) throw new Error(`Файл для запуска не найден: ${entryFileName}`);

    const created = parseJson<DockerCreateResponse>(
      await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
        Image: RUNNER_IMAGE,
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ['python', `/app/${entryFileName}`],
        HostConfig: {
          NetworkMode: 'none',
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500_000_000
        }
      })
    );
    containerId = created.Id;

    await dockerRequest('PUT', `/containers/${containerId}/archive?path=${encodeURIComponent('/app')}`, createTarArchive(files), 'application/x-tar');
    const attachedLogs = attachContainerLogs(containerId, output, () => void stopContainer('output-limit'));
    detachLogs = attachedLogs.close;

    if (options.signal?.aborted) await stopContainer('stopped');
    stopListener = () => void stopContainer('stopped');
    options.signal?.addEventListener('abort', stopListener, { once: true });

    await dockerRequest('POST', `/containers/${containerId}/start`);

    timeout = setTimeout(() => void stopContainer('timeout'), TIMEOUT_MS);
    const waitPromise = dockerRequest('POST', `/containers/${containerId}/wait`).then((data) => parseJson<DockerWaitResponse>(data));
    const waitResult = await waitPromise;
    await Promise.race([attachedLogs.finished.catch(() => undefined), delay(1000)]);
    const logs = output.getOutput();

    const exitCode = waitResult?.StatusCode ?? null;
    if (stopReason === 'stopped') {
      return {
        status: 'stopped',
        stdout: logs.stdout,
        stderr: appendMessage(logs.stderr, 'Execution stopped by user'),
        exitCode: null
      };
    }

    if (stopReason === 'timeout') {
      return {
        status: 'error',
        stdout: logs.stdout,
        stderr: appendMessage(logs.stderr, `Timeout: выполнение остановлено через ${Math.round(TIMEOUT_MS / 1000)} секунд`),
        exitCode: null
      };
    }

    if (stopReason === 'output-limit') {
      return {
        status: 'error',
        stdout: logs.stdout,
        stderr: appendMessage(logs.stderr, `Output limit exceeded: вывод ограничен ${Math.round(MAX_OUTPUT_BYTES / 1024)} KB`),
        exitCode: null
      };
    }

    return {
      status: exitCode === 0 ? 'success' : 'error',
      stdout: logs.stdout,
      stderr: logs.stderr,
      exitCode
    };
  } catch (error) {
    return {
      status: 'error',
      stdout: '',
      stderr: error instanceof Error ? error.message : 'Ошибка Docker runner',
      exitCode: null
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (stopListener) options.signal?.removeEventListener('abort', stopListener);
    detachLogs?.();
    if (containerId) await removeContainer(containerId);
  }
}
