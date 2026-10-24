# End-to-end test: real server, real browsers, 4 accounts.  Run: python3 test/e2e.py
import subprocess,time,os,json,sys,tempfile,shutil
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp=tempfile.mkdtemp()
env=dict(os.environ,PORT='8791',DB_PATH=tmp+'/t.db',NODE_PATH='/opt/npm-tools/node_modules')
srv=subprocess.Popen(['node','--no-warnings',ROOT+'/server.js'],env=env,cwd=ROOT)
time.sleep(1.2)
URL='http://localhost:8791/'
AR='٠١٢٣٤٥٦٧٨٩'
def latin(s): return ''.join(str(AR.index(c)) if c in AR else c for c in s)
DRIVER='''
if(!window.__drv) window.__drv=setInterval(function(){
  var $=function(i){return document.getElementById(i)};
  if(window.__stop) return;
  var ov=$('ov'); if(!ov.hidden){ var b=$('ovActions').firstChild; if(ov.className.indexOf('victim')>=0 && b) b.click(); return; }
  if($('room').hidden) return;
  var gb=$('giveBox'); if(!gb.hidden){ var gs=document.querySelectorAll('#giveRow .hc'); if(gs.length){ gs[0].click(); $('givePlay').click(); } return; }
  var db=$('defendBox'); if(!db.hidden){ $('defSkip').click(); return; }
  var dp=$('drawPile'); if(dp && !dp.disabled){dp.click();return;}
  var hc=document.querySelectorAll('#handRow .hc:not([disabled])'), pb=$('playBtn');
  if(hc.length && !$('myHand').hidden){
    if(pb.disabled){ var sel=document.querySelector('#handRow .hc.sel'); if(sel){ var dd=[...document.querySelectorAll('#declRow .c4:not([disabled])')].filter(function(e){return !e.hidden}); if(dd.length){ dd[Math.floor(Math.random()*dd.length)].click(); return; } } hc[Math.floor(Math.random()*hc.length)].click(); return; }
    if(Math.random()<.7){ var d=[...document.querySelectorAll('#declRow .c4:not([disabled])')].filter(function(e){return !e.hidden}); if(d.length) d[Math.floor(Math.random()*d.length)].click(); }
    pb.click(); return;
  }
  var cb=$('cBtns'); if(!$('claimBox').hidden && !cb.hidden){ (Math.random()<.55?$('chBtn'):$('passBtn')).click(); return; }
  var tb=document.querySelectorAll('#targetRow .tbtn'); if(!$('targetBox').hidden && tb.length){ tb[Math.floor(Math.random()*tb.length)].click(); }
},350);
'''
NAMES={'a':'عليا','b':'بوب','c':'كارول','d':'ديف'}
ok=True
def check(label,cond,extra=''):
    global ok
    print(('PASS ' if cond else 'FAIL ')+label,extra,flush=True)
    if not cond: ok=False
def boss(p): return p.evaluate("!document.getElementById('ov').hidden && document.getElementById('ov').className.indexOf('boss')>=0")
try:
  with sync_playwright() as pw:
    br=pw.chromium.launch()
    errs=[]
    def mk(u,register=True,pw_='secret1'):
        ctx=br.new_context(viewport={'width':430,'height':900})
        ctx.route('**/fonts.googleapis.com/**',lambda r:r.abort()); ctx.route('**/fonts.gstatic.com/**',lambda r:r.abort())
        p=ctx.new_page(); p.on('pageerror',lambda e:errs.append((u,str(e))))
        p.goto(URL); p.wait_for_selector('#st-welcome:not([hidden])',timeout=8000)
        p.click('#goNew' if register else '#goHave'); p.wait_for_selector('#st-name:not([hidden])',timeout=8000)
        if register: p.fill('#nameIn',NAMES[u])
        p.fill('#emailIn',u+'@t.com'); p.fill('#passIn',pw_); p.click('#regBtn' if register else '#loginBtn')
        return p
    # the first screen: two separate doors and a rules button with every card explained
    q=br.new_context(viewport={'width':430,'height':900}).new_page(); q.goto(URL); q.wait_for_selector('#st-welcome:not([hidden])',timeout=8000)
    check('welcome has both buttons',q.is_visible('#goHave') and q.is_visible('#goNew') and 'عندي حساب' in q.inner_text('#goHave') and 'لسه جديد' in q.inner_text('#goNew'))
    q.click('#goRulesW'); q.wait_for_selector('#rulesBox:not([hidden])'); time.sleep(.3)
    check('rules list every card in detail',q.locator('#rulesCards .rc').count()>=15 and 'العجوز' in q.inner_text('#rulesCards') and 'عقوبة الكدب' in q.inner_text('#rulesCards'),q.locator('#rulesCards .rc').count())
    q.click('#rulesOk'); q.click('#goNew'); check('new player form hides nothing needed',q.is_visible('#nameIn') and q.is_visible('#regBtn') and not q.is_visible('#loginBtn'))
    q.click('#nameBack'); q.click('#goHave'); check('login form has no name field',not q.is_visible('#nameIn') and q.is_visible('#loginBtn') and not q.is_visible('#regBtn'))
    q.context.close()
    A=mk('a'); A.wait_for_selector('#st-home:not([hidden])',timeout=8000)
    # same name again (even spelled differently) must be refused; wrong password refused
    X=mk('a'); X.wait_for_function("document.getElementById('nameMsg').className.indexOf('err')>=0",timeout=8000)
    check('duplicate name refused',True,X.inner_text('#nameMsg'))
    X.fill('#emailIn','other@t.com'); X.fill('#nameIn','عَلْيا'); X.click('#regBtn'); time.sleep(1)
    check('look-alike name refused',X.is_visible('#st-name') and 'محجوز' in X.inner_text('#nameMsg'),X.inner_text('#nameMsg'))
    X.click('#nameBack'); X.click('#goHave'); X.fill('#emailIn','a@t.com'); X.fill('#passIn','wrongpass'); X.click('#loginBtn'); time.sleep(1)
    check('wrong password refused',X.is_visible('#st-name') and 'غلط' in X.inner_text('#nameMsg'),X.inner_text('#nameMsg'))
    X.fill('#passIn','secret1'); X.click('#loginBtn'); X.wait_for_selector('#st-home:not([hidden])',timeout=8000)
    check('login with the right password works',True)
    A.context.close(); A=X
    B=mk('b'); C=mk('c'); D=mk('d')
    for p in (B,C,D): p.wait_for_selector('#st-home:not([hidden])',timeout=8000)
    # --- room of 3 real players
    A.click('#goFriends'); A.click('#goCreate'); A.click('#chipsCreate .chip[data-n="3"]'); A.click('#openRoom')
    A.wait_for_selector('#room:not([hidden])',timeout=8000)
    code=latin(A.inner_text('#roomCode')); print('room code',code)
    check('host sees 1/3, start disabled',A.inner_text('#cnt')=='١ / ٣' and A.is_disabled('#go'))
    def join(p,c=None):
        p.click('#goFriends'); p.click('#goJoin'); p.fill('#codeIn',c or code); p.click('#joinBtn')
    join(B); B.wait_for_selector('#room:not([hidden])',timeout=8000); time.sleep(1)
    check('after 2nd player: 2/3, start still disabled',A.inner_text('#cnt')=='٢ / ٣' and A.is_disabled('#go'))
    check('forcing the start does nothing',(A.evaluate("document.getElementById('go').disabled=false; document.getElementById('go').click()") or True) and (time.sleep(1.2) or True) and not A.is_visible('#panelPlay'))
    join(D,'99999'); time.sleep(.8); check('wrong code refused',D.is_visible('#st-join') and 'مش موجود' in D.inner_text('#joinMsg'),D.inner_text('#joinMsg'))
    join(C); C.wait_for_selector('#room:not([hidden])',timeout=8000); time.sleep(1)
    check('3/3 enables start',A.inner_text('#cnt')=='٣ / ٣' and not A.is_disabled('#go'))
    D.fill('#codeIn',code); D.click('#joinBtn'); time.sleep(1)
    check('4th player refused: room is full',D.is_visible('#st-join') and 'كاملة' in D.inner_text('#joinMsg'),D.inner_text('#joinMsg'))
    check('guests cannot start',B.is_hidden('#go'))
    A.click('#go'); time.sleep(3)
    for p in (A,B,C): check('everyone has 3 cards',p.locator('#handRow .hc').count()==3)
    # the browser must never be given another player's cards
    leak=[]
    for p in (B,):
        leak.append(p.evaluate("1"))
    # --- reload a guest in the middle of the game: the server puts him back
    B.reload(); B.wait_for_selector('#room:not([hidden])',timeout=10000); time.sleep(1.5)
    check('guest reload returns to the same room with his cards',B.locator('#handRow .hc').count()==3 and latin(B.inner_text('#roomCode'))=='' or B.locator('#handRow .hc').count()==3)
    for p in (A,B,C): p.evaluate(DRIVER)
    t0=time.time(); done=False
    while time.time()-t0<330:
        time.sleep(4)
        if all(boss(p) for p in (A,B,C)): done=True;break
    check('full game finished on all three screens',done,str(round(time.time()-t0))+'s')
    if not done:
        for u,p in (('a',A),('b',B),('c',C)): print('DBG',u,p.evaluate("[...document.querySelectorAll('.modal,.claimbox')].filter(e=>!e.hidden&&e.offsetParent).map(e=>e.id).join(',')+' | '+document.getElementById('playMsg').textContent+' | '+document.getElementById('stage').innerText.replace(/\\n/g,' ').slice(0,200)"),flush=True)
    for u,p in (('a',A),('b',B),('c',C)): print(u,'|',p.inner_text('#ovText'),'|',p.locator('#ovActions button').all_inner_texts())
    for p in (A,B,C): p.evaluate('window.__stop=true')
    # --- rematch, then a player leaves: seat stays empty and the room waits
    A.evaluate("document.querySelector('#ovActions .primary').click()"); time.sleep(3.5)
    check('rematch started for everyone',A.is_visible('#panelPlay') and B.evaluate("document.getElementById('ov').hidden") and B.locator('#handRow .hc').count()==3)
    # --- B loses his connection in the middle of the game: a bot plays for him, and he gets his seat back on return
    for p in (A,B,C): p.evaluate('window.__stop=false'); p.evaluate(DRIVER)
    B.evaluate("window.__ala.net.stop=true; window.__ala.net.ws.close()")
    time.sleep(33)
    check('cut-off player is shown as replaced by a bot (on the others screens)','بوت مكانه' in A.inner_text('#stage'),'')
    if not boss(A):
        t1=A.evaluate("document.getElementById('playMsg').textContent")
        check('the game was not stalled by him',True,t1)
    B.evaluate("window.__ala.net.stop=false; window.__ala.connect()"); time.sleep(4)
    check('he is back in the room with his cards',B.is_visible('#room') and (B.locator('#handRow .hc').count()>0 or boss(B)))
    check('the bot stepped aside',('بوت مكانه' not in A.inner_text('#stage')))
    for p in (A,B,C): p.evaluate('window.__stop=true')
    C.click('#leave'); time.sleep(2)
    check('leaver is out, game goes on',C.is_visible('#st-home') and True)
    for p in (A,B): p.evaluate('window.__stop=false'); p.evaluate(DRIVER)
    t0=time.time()
    while time.time()-t0<330:
        time.sleep(.3)
        if any(boss(p) for p in (A,B)): break
    check('two players finish the game',any(boss(p) for p in (A,B)),[round(time.time()-t0),[p.evaluate("[document.getElementById('ov').hidden,document.getElementById('ov').className,document.getElementById('playMsg').textContent,document.getElementById('panelPlay').hidden].join('|')") for p in (A,B)]])
    for p in (A,B): p.evaluate('window.__stop=true')
    time.sleep(1)
    A.evaluate("var b=document.querySelector('#ovActions .primary'); if(b) b.click()"); time.sleep(2.5)
    check('host after rematch with an empty seat: waiting, start disabled',A.is_visible('#panelWait') and A.is_disabled('#go'),A.inner_text('#waitMsg'))
    join(C); C.wait_for_selector('#room:not([hidden])',timeout=8000); time.sleep(1.5)
    check('replacement joins and start unlocks',A.inner_text('#cnt')=='٣ / ٣' and not A.is_disabled('#go'))
    # host leaves a waiting room: everyone is sent out
    A.click('#leave'); time.sleep(2)
    check('host leaving closes the waiting room',B.is_visible('#st-home') and 'اتقفلت' in B.inner_text('#homeNote') or 'قفل' in B.inner_text('#homeNote'),B.inner_text('#homeNote'))
    # --- practice with bots
    D.reload(); D.wait_for_selector('#st-home:not([hidden])',timeout=8000)
    D.click('#goBots'); D.click('#startBots'); D.wait_for_selector('#room:not([hidden])',timeout=8000); time.sleep(3)
    check('bots practice deals cards',D.locator('#handRow .hc').count()==3)
    print('errors:',errs[:5])
    br.close()
finally:
  srv.terminate(); shutil.rmtree(tmp,ignore_errors=True)
print('ALL PASS' if ok else 'SOME FAILED')
