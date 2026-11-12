"""Run with local backend, Vite and geckodriver on port 4444 (Python stdlib only)."""
import json
import time
import urllib.request

urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
DRIVER = 'http://127.0.0.1:4444'
SITE = 'http://localhost:5173'


def request(path, body=None, method=None):
    req = urllib.request.Request(DRIVER + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'}, method=method)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


session = request('/session', {'capabilities': {'alwaysMatch': {
    'browserName': 'firefox', 'moz:firefoxOptions': {'args': ['-headless']}}}})['sessionId']
prefix = '/session/' + session


def js(source, *args):
    return request(prefix + '/execute/sync', {'script': source, 'args': list(args)})


def async_js(source, *args):
    return request(prefix + '/execute/async', {'script': source, 'args': list(args)})


def until(source, message):
    for _ in range(150):
        if js(source):
            return
        time.sleep(.1)
    raise AssertionError(message + ': ' + str(js("return {text:document.body.innerText.slice(-800), editor:!!window.editor, models:window.monaco?.editor.getModels().length, sent:window.sent, sockets:window.sockets?.map(s=>[s.url,s.readyState])}")))


def switch(handle):
    request(prefix + '/window', {'handle': handle})


def value():
    return js('return window.editor.getValue()')


instrument = """
const Native = window.WebSocket;
window.sockets = [];
window.sent = [];
window.blockY = false;
window.blockJson = false;
window.WebSocket = class extends Native {
  constructor(url, protocols) {
    const block = (window.blockY && url.includes('/yjs/')) || (window.blockJson && url.endsWith('/ws'));
    super(block ? 'ws://127.0.0.1:59999' : url, protocols);
    window.sockets.push(this);
  }
  send(data) { if (typeof data === 'string') window.sent.push(JSON.parse(data)); super.send(data); }
};
"""

try:
    request(prefix + '/url', {'url': SITE})
    js("sessionStorage.setItem('clientId', 'duplicated-tab-id')")
    room = async_js("fetch('/api/rooms',{method:'POST'}).then(r=>r.json()).then(arguments[0])")['roomId']
    a = request(prefix + '/window')
    js("window.open('/', '_blank')")
    handles = request(prefix + '/window/handles')
    b = next(handle for handle in handles if handle != a)
    for handle, name in [(a, 'A'), (b, 'B')]:
        switch(handle)
        until("return document.querySelector('.homePage') || document.querySelector('main')", 'Home did not load')
        assert js("return sessionStorage.getItem('clientId')") == 'duplicated-tab-id'
        js(instrument)
        js("history.pushState({},'',arguments[0]); dispatchEvent(new PopStateEvent('popstate'))", '/room/' + room)
        until("return !!document.querySelector('.nameDialog input')", 'Join form missing')
        element = request(prefix + '/element', {'using': 'css selector', 'value': '.nameDialog input'})['element-6066-11e4-a52e-4f735466cecf']
        request(prefix + '/element/' + element + '/clear', {})
        request(prefix + '/element/' + element + '/value', {'text': name})
        js("document.querySelector('.nameDialog button').click()")
        until("return document.querySelector('.view-lines')?.textContent.includes('Hello') && !document.querySelector('.editorLoadingOverlay')", 'Editor missing')
        js("""
          const root=document.querySelector('.roomPage');
          let fiber=root[Object.keys(root).find(k=>k.startsWith('__reactFiber$'))];
          while(fiber) {
            let hook=fiber.memoizedState;
            while(hook && typeof hook==='object') {
              const ref=hook.memoizedState?.current;
              if(ref?.executeEdits && ref?.getModel) window.editor=ref;
              if(ref?.editor?.createModel) window.monaco=ref;
              if(ref?.getText && ref?.transact) window.ydoc=ref;
              if(ref?.ytext && ref?.monacoModel) window.Binding=ref.constructor;
              hook=hook.next;
            }
            fiber=fiber.return;
          }
        """)
        until('return window.editor && !editor.getOption(monaco.editor.EditorOption.readOnly)', 'Editor stayed read-only')
    state = async_js("fetch('/api/rooms/'+arguments[0]).then(r=>r.json()).then(arguments[1])", room)
    assert len(state['users']) == 2 and len({u['clientId'] for u in state['users']}) == 2
    print('PASS: duplicated sessionStorage produces two independent participants', flush=True)

    eol = js("""
      function probe(eol) {
        const doc=new ydoc.constructor();
        const text=doc.getText('probe');
        const model=monaco.editor.createModel('', 'plaintext');
        model.setEOL(eol);
        const binding=new Binding(text,model);
        text.insert(0,'one\\ntwo\\nthree');
        const afterRemote=model.getValue()===text.toString();
        if(afterRemote) model.applyEdits([{range:new monaco.Range(3,1,3,6),text:'THREE'}]);
        const afterLocal=model.getValue()===text.toString();
        binding.destroy(); model.dispose(); doc.destroy();
        return {afterRemote,afterLocal};
      }
      return {windowsDefault:probe(monaco.editor.EndOfLineSequence.CRLF),fixed:probe(monaco.editor.EndOfLineSequence.LF)};
    """)
    assert not eol['windowsDefault']['afterRemote'], eol
    assert eol['fixed']['afterRemote'] and eol['fixed']['afterLocal'], eol
    print('PASS: reproduced CRLF offset divergence; LF keeps Monaco and Y.Text identical', flush=True)

    # Exercise actual Monaco changes, not just Y.Doc messages.
    switch(a)
    js("editor.executeEdits('test',[{range:editor.getModel().getFullModelRange(),text:'alpha\\nbeta\\ngamma'}])")
    switch(b)
    until("return editor.getValue()==='alpha\\nbeta\\ngamma'", 'Initial replacement did not sync')
    target = int(time.time() * 1000) + 800
    for handle, text in [(a, '# A\n'), (b, '# B\n')]:
        switch(handle)
        js("setTimeout(()=>editor.executeEdits('test',[{range:new monaco.Range(2,1,2,1),text:arguments[1]}]),Math.max(0,arguments[0]-Date.now()))", target, text)
    until("return editor.getValue().includes('# A') && editor.getValue().includes('# B')", 'Concurrent edits missing')
    expected = value()
    switch(a)
    until("return editor.getValue().includes('# A') && editor.getValue().includes('# B')", 'Other participant missing edits')
    assert value() == expected
    print('PASS: simultaneous Monaco edits converge', flush=True)

    js("window.beforeModel=editor.getModel(); editor.setPosition({lineNumber:1,column:3}); window.blockY=true; sockets.findLast(s=>s.url.includes('/yjs/') && s.readyState===1).close()")
    until('return editor.getOption(monaco.editor.EditorOption.readOnly)', 'Disconnected editor still writable')
    switch(b)
    js("editor.executeEdits('test',[{range:new monaco.Range(3,1,3,1),text:'# while offline\\n'}])")
    expected = value()
    switch(a)
    js('window.blockY=false')
    until("return !editor.getOption(monaco.editor.EditorOption.readOnly) && editor.getValue().includes('# while offline')", 'Reconnect did not recover edits')
    assert js('return editor.getModel()===window.beforeModel')
    assert value() == expected
    assert js('return editor.getPosition().lineNumber===1 && editor.getPosition().column===3')
    print('PASS: reconnect preserves model/selection and applies missed edits', flush=True)

    js("window.blockJson=true; sockets.findLast(s=>s.url.endsWith('/ws') && s.readyState===1).close()")
    until('return editor.getOption(monaco.editor.EditorOption.readOnly)', 'Lost metadata socket did not block editing')
    switch(b)
    js("sockets.findLast(s=>s.url.endsWith('/ws') && s.readyState===1).send(JSON.stringify({type:'createFile',roomId:arguments[0],name:'windows.txt',content:'one\\r\\ntwo\\r\\nthree'}))", room)
    until("return document.querySelector('.fileList').textContent.includes('windows.txt')", 'New file missing')
    switch(a)
    js('window.blockJson=false')
    until("return !editor.getOption(monaco.editor.EditorOption.readOnly) && document.querySelector('.fileList').textContent.includes('windows.txt')", 'Metadata reconnect failed')
    js("[...document.querySelectorAll('.fileName')].find(e=>e.textContent.includes('windows.txt')).click()")
    until("return editor.getValue()==='one\\ntwo\\nthree'", 'CRLF file not normalized')
    assert js("return editor.getModel().getEOL()==='\\n'")
    js("editor.executeEdits('test',[{range:new monaco.Range(3,1,3,6),text:'THREE'}])")
    switch(b)
    assert '# while offline' in value(), 'Selecting a file changed another participant selection'
    js("[...document.querySelectorAll('.fileName')].find(e=>e.textContent.includes('windows.txt')).click()")
    until("return editor.getValue()==='one\\ntwo\\nTHREE'", 'Edit after CRLF import did not sync')
    state = async_js("fetch('/api/rooms/'+arguments[0]).then(r=>r.json()).then(arguments[1])", room)
    assert next(f['content'] for f in state['files'] if f['name'] == 'windows.txt') == value()
    print('PASS: metadata reconnect, independent file selection, CRLF import and server text agree', flush=True)
finally:
    request(prefix, method='DELETE')
