#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
index=(ROOT/'public/index.html').read_text();styles=(ROOT/'public/styles.css').read_text();seed=(ROOT/'public/seed.js').read_text().replace('export const ','const ');app=(ROOT/'public/app.js').read_text();app=app[app.index("} from './seed.js';")+len("} from './seed.js';"):]
aliases="const seedSubmissions=submissions,seedRubric=rubric,seedFormFields=formFields,seedSchedule=scheduleSessions,seedTasks=tasks,seedProgramme=programmeSessions,seedIntegrations=integrations;"
body=index[index.index('<body>')+6:index.index('</body>')].replace('<script type="module" src="./app.js"></script>','')
html=f"<!doctype html><html><head><meta charset='utf-8'><style>{styles}</style></head><body>{body}<script>const __store=new Map();Object.defineProperty(window,'localStorage',{{value:{{getItem:k=>__store.has(k)?__store.get(k):null,setItem:(k,v)=>__store.set(k,String(v)),removeItem:k=>__store.delete(k),clear:()=>__store.clear()}}}});{seed}\n{aliases}\n{app}</script></body></html>"
routes={'command-centre':'#admin/command','review-workbench':'#admin/review','form-builder':'#admin/submissions/form','schedule-planner':'#admin/schedule','communications':'#admin/communications','tasks-readiness':'#admin/tasks','speaker-portal':'#speaker/dashboard','speaker-resources':'#speaker/resources','public-programme':'#public/programme'}
out=ROOT/'docs/screenshots';out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
    page.set_content(html,wait_until='load')
    for name,route in routes.items():
        page.evaluate('route=>location.hash=route',route);page.wait_for_timeout(80)
        page.screenshot(path=str(out/f'{name}.png'),full_page=True)
        print(out/f'{name}.png')
    browser.close()
