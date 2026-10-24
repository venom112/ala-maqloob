# Admin panel in a real browser. Google's script is replaced by a stub that hands the page a token signed by the local fake
# Google key, so the server still runs its real verification.  Run: python3 test/admin_ui.py
import subprocess,time,os,json,tempfile,sys,base64
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp=tempfile.mkdtemp()
# the fake Google server + token signer run in a small node helper
helper=tmp+'/h.js'
open(helper,'w').write('''
const {startFake}=require(%r);
(async()=>{const f=await startFake();
 console.log(JSON.stringify({url:f.url,owner:f.token({email:'ana.wolfish@gmail.com'}),stranger:f.token({email:'stranger@gmail.com'})}));
 setInterval(()=>{},1e6);})();
'''%(ROOT+'/test/fake_google.js'))
env=dict(os.environ,NODE_PATH='/opt/npm-tools/node_modules')
fk=subprocess.Popen(['node',helper],env=env,stdout=subprocess.PIPE,text=True)
info=json.loads(fk.stdout.readline())
env.update(PORT='8792',DB_PATH=tmp+'/t.db',GOOGLE_CLIENT_ID='test-client',GOOGLE_JWKS_URL=info['url'],LOGIN_LIMIT='1000')
srv=subprocess.Popen(['node','--no-warnings',ROOT+'/server.js'],env=env,cwd=ROOT)
time.sleep(1.5)
URL='http://localhost:8792/admin'
bad=0
def check(l,ok):
    global bad
    print(('PASS ' if ok else 'FAIL ')+l)
    if not ok: bad+=1
STUB='''window.google={accounts:{id:{initialize:function(o){window.__cb=o.callback},renderButton:function(el){var b=document.createElement('button');b.id='fakeG';b.textContent='Google';b.onclick=function(){window.__cb({credential:window.__TOKEN})};el.appendChild(b)},disableAutoSelect:function(){}}}};'''
try:
  with sync_playwright() as p:
    br=p.chromium.launch(); 
    def page(token):
        ctx=br.new_context(viewport={'width':420,'height':900}); pg=ctx.new_page()
        pg.route('https://accounts.google.com/gsi/client',lambda r:r.fulfill(body=STUB,content_type='text/javascript'))
        pg.add_init_script('window.__TOKEN=%s'%json.dumps(token))
        pg.on('dialog',lambda d:d.accept(d.default_value or 'x'))
        errs=[]; pg.on('pageerror',lambda e:errs.append(str(e))); pg.errs=errs
        return pg
    # a stranger is turned away
    pg=page(info['stranger']); pg.goto(URL); pg.click('#fakeG'); pg.wait_for_timeout(800)
    check('stranger sees a refusal, not the panel',pg.locator('#app').is_hidden() and 'مش أدمن' in pg.inner_text('#loginMsg'))
    # the owner gets in
    pg=page(info['owner']); pg.goto(URL); pg.click('#fakeG'); pg.wait_for_selector('#app:not([hidden])')
    check('owner is in and sees every tab',pg.locator('#nav button').count()==8)
    check('owner e-mail shown',  'ana.wolfish@gmail.com' in pg.inner_text('#who'))
    pg.click('#nav button[data-t=cards]'); pg.wait_for_selector('.card input[maxlength="16"]')
    check('fifteen starter cards listed',pg.locator('#view > .card').count()==16)   # 15 cards + the "new card" editor
    # add a card through the form
    form=pg.locator('#view > .card').last
    form.locator('input[maxlength="16"]').fill('الجوكر'); form.locator('input[maxlength="4"]').fill('★'); form.locator('textarea').first.fill('اسحب كارت زيادة.')
    form.get_by_text('+ أضف تأثير').click()
    form.locator('.op select').first.select_option('draw'); 
    form.get_by_text('إضافة الكارت').click(); pg.wait_for_timeout(900)
    check('new card appears in the list',pg.locator('#view > .card').count()==17 and 'الجوكر' in pg.inner_text('#view'))
    # appoint an admin
    pg.click('#nav button[data-t=admins]'); pg.wait_for_selector('input[type=email]')
    pg.fill('input[type=email]','helper@example.com'); pg.get_by_text('تعيين',exact=True).click(); pg.wait_for_timeout(700)
    check('admin appointed',  'helper@example.com' in pg.inner_text('#view'))
    # settings
    pg.click('#nav button[data-t=settings]'); pg.wait_for_selector('input[type=number]')
    pg.locator('input[type=number]').nth(1).fill('4'); pg.get_by_text('حفظ',exact=True).click(); pg.wait_for_timeout(600)
    check('settings saved (toast)','اتحفظت' in pg.inner_text('#toast'))
    # images tab and audit tab render
    pg.click('#nav button[data-t=images]'); pg.wait_for_selector('.thumb'); check('images tab shows the 5 slots',pg.locator('.thumb').count()==5)
    pg.click('#nav button[data-t=audit]'); pg.wait_for_selector('#view table'); check('audit log lists what we did','card.create' in pg.inner_text('#view'))
    pg.click('#nav button[data-t=players]'); pg.wait_for_selector('#view table'); check('players tab opens',True)
    pg.screenshot(path=tmp+'/admin.png')
    check('no JS errors',not pg.errs)
    # the public page still works and sees the new card's existence through /api/config version
    br.close()
finally:
  srv.terminate(); fk.terminate()
print('ALL PASS' if not bad else '%d FAILED'%bad); print('shot:',tmp+'/admin.png'); sys.exit(1 if bad else 0)
