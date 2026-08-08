#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
index=(ROOT/'public/index.html').read_text()
styles=(ROOT/'public/styles.css').read_text()
seed=(ROOT/'public/seed.js').read_text().replace('export const ','const ')
app=(ROOT/'public/app.js').read_text()
end=app.index("} from './seed.js';")+len("} from './seed.js';")
app=app[end:]
aliases="""
const seedSubmissions=submissions, seedRubric=rubric, seedFormFields=formFields,
      seedSchedule=scheduleSessions, seedTasks=tasks, seedProgramme=programmeSessions,
      seedIntegrations=integrations;
"""
body=index[index.index('<body>')+6:index.index('</body>')]
body=body.replace('<script type="module" src="./app.js"></script>','')
html=f"""<!doctype html><html><head><meta charset='utf-8'><style>{styles}</style></head><body>{body}<script>
const __store=new Map();Object.defineProperty(window,'localStorage',{{value:{{getItem:k=>__store.has(k)?__store.get(k):null,setItem:(k,v)=>__store.set(k,String(v)),removeItem:k=>__store.delete(k),clear:()=>__store.clear()}}}});
{seed}\n{aliases}\n{app}
</script></body></html>"""
routes=['#admin/command','#admin/event','#admin/submissions','#admin/submissions/form','#admin/review','#admin/speakers','#admin/schedule','#admin/communications','#admin/tasks','#admin/programme','#admin/integrations','#admin/settings','#admin/assistant','#speaker/dashboard','#speaker/resources','#public/programme','#apply/form','#design/system']
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1440,'height':900})
    page.on('pageerror',lambda exc: errors.append(f'pageerror: {exc}'))
    page.on('console',lambda msg: errors.append(f'console {msg.type}: {msg.text}') if msg.type=='error' else None)
    page.set_content(html,wait_until='load')
    for route in routes:
        page.evaluate("route=>{location.hash=route}",route)
        page.wait_for_timeout(30)
        h1=page.locator('h1').first
        if h1.count()==0: errors.append(f'{route}: no h1')
        else: print(route,'=>',h1.inner_text())
    # Global keyboard palette and focus-safe dismissal.
    page.evaluate("location.hash='#admin/command'");page.wait_for_timeout(30)
    page.keyboard.press('Control+K');assert page.locator('.command-box').count()==1
    page.keyboard.press('Escape');assert page.locator('.command-box').count()==0
    # Direct-session creation is functional and bypasses review by design.
    page.evaluate("location.hash='#admin/submissions'");page.wait_for_timeout(30)
    page.locator('[data-create-direct-session]').click();page.locator('#direct-session-title').fill('Sponsor innovation keynote');page.locator('#direct-session-speaker').fill('Morgan Patel');page.locator('[data-confirm-direct-session]').click();page.wait_for_timeout(30)
    assert page.locator('text=Sponsor innovation keynote').count()>=1
    page.evaluate("location.hash='#admin/schedule'");page.wait_for_timeout(30)
    assert page.locator('text=Sponsor innovation keynote').count()>=1
    page.locator('[data-unscheduled-session]').first.click();page.select_option('#move-session-room','303');page.select_option('#move-session-start','855');page.locator('[data-confirm-schedule-move]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.schedule.proposed && state.schedule.proposed.end-state.schedule.proposed.start')==60
    page.evaluate('state.schedule.proposed=null;save();render()');page.wait_for_timeout(30)
    # Event setup persists room changes and validates schedule-safe removal.
    page.evaluate("location.hash='#admin/event'");page.wait_for_timeout(30)
    page.locator('[data-add-room]').click();page.locator('#new-room-name').fill('Room 304');page.locator('#new-room-capacity').fill('120');page.locator('[data-confirm-add-room]').click();page.wait_for_timeout(30)
    assert page.locator('input[value="Room 304"]').count()==1
    page.locator('[data-invite-admin]').click();page.locator('#invite-admin-name').fill('Dean Smith');page.locator('#invite-admin-email').fill('dean@example.com');page.locator('[data-confirm-admin-invite]').click();page.wait_for_timeout(30)
    assert page.locator('text=Dean Smith').count()>=1
    # Speaker operations include filtering and invitation creation.
    page.evaluate("location.hash='#admin/speakers'");page.wait_for_timeout(30)
    page.locator('[data-speaker-query]').fill('Jamie');page.wait_for_timeout(250)
    assert page.locator('text=Jamie Lee').count()>=1 and page.locator('text=Alex Morgan').count()==0
    page.locator('[data-speaker-query]').fill('');page.wait_for_timeout(250)
    page.locator('[data-invite-speaker]').click();page.locator('#invite-speaker-name').fill('Avery Chen');page.locator('#invite-speaker-email').fill('avery@example.com');page.locator('[data-confirm-speaker-invite]').click();page.wait_for_timeout(30)
    assert page.locator('text=Avery Chen').count()>=1
    # Submission filtering is functional.
    page.evaluate("location.hash='#admin/submissions'");page.wait_for_timeout(30)
    page.locator('[data-submission-query]').fill('inclusive hybrid');page.wait_for_timeout(250)
    assert page.locator('text=Designing inclusive hybrid experiences').count()>=1 and page.locator('text=Data-driven event strategy').count()==0
    page.locator('[data-submission-query]').fill('');page.wait_for_timeout(250)
    # Review maths and conflict-return state.
    page.evaluate("location.hash='#admin/review'");page.wait_for_timeout(30)
    page.locator('[data-manage-evaluation]').click();page.locator('[data-add-evaluation-round]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.review.plan.rounds.length')==3
    page.locator('[data-rubric="rel"] [data-rating="5"]').click()
    assert '4.50' in page.locator('[data-total-score]').inner_text()
    page.locator('input[name="conflict"][value="yes"]').check();page.wait_for_timeout(30)
    assert page.locator('[data-return-assignment]').count()==1 and page.locator('[data-scoring].hidden').count()==1
    page.locator('[data-return-assignment]').click();page.wait_for_timeout(30)
    page.locator('[data-submit-review]').click();page.wait_for_timeout(30)
    page.evaluate("location.hash='#admin/submissions'");page.wait_for_timeout(30)
    assert page.locator('[data-decide-sub="SUB-2567"]').count()==1
    page.locator('[data-decide-sub="SUB-2567"]').click();page.locator('[data-confirm-decision="accept"]').click();page.wait_for_timeout(30)
    assert page.locator('tr',has_text='The future of attendee engagement').locator('text=Accepted').count()==1
    page.evaluate("location.hash='#admin/schedule'");page.wait_for_timeout(30)
    assert page.locator('text=The future of attendee engagement').count()>=1
    for view in ['List','Day','Week','Track','Room']:
        page.locator(f'[data-schedule-view="{view}"]').click();page.wait_for_timeout(30)
        assert page.evaluate('state.ui.scheduleView')==view
    page.locator('[data-apply-schedule]').click()
    assert page.locator('text=Resolution staged').count()>=1
    page.evaluate("location.hash='#public/programme'");page.wait_for_timeout(30)
    page.locator('[data-public-query]').fill('Hybrid')
    page.wait_for_timeout(300)
    assert page.locator('.programme-list [data-public-session]').count()==1
    page.evaluate("location.hash='#apply/form'");page.wait_for_timeout(30)
    assert page.locator('textarea[name="materials"]').count()==1
    page.locator('input[name="title"]').fill('A saved draft proposal');page.locator('[data-save-application]').first.click();page.wait_for_timeout(30)
    page.locator('[data-new-application-draft]').click();page.wait_for_timeout(30)
    assert page.locator('text=A saved draft proposal').count()>=1
    page.select_option('[data-app-format]','Panel');page.wait_for_timeout(50)
    assert page.locator('textarea[name="materials"]').count()==0
    # Task views and bulk completion perform real state changes.
    page.evaluate("location.hash='#admin/tasks'");page.wait_for_timeout(30)
    page.locator('[data-task-view="session"]').click();page.wait_for_timeout(30)
    assert 'session readiness tasks' in page.locator('.tasks-layout .tiny.subtle').first.inner_text().lower()
    page.locator('[data-task-select]').first.check();page.locator('[data-bulk-complete]').click();page.wait_for_timeout(30)
    assert page.locator('text=Completed').count()>=1
    page.locator('[data-create-task]').click();page.locator('#new-task-name').fill('Confirm session accessibility');page.select_option('#new-task-entity','Session');page.locator('[data-add-task]').click();page.wait_for_timeout(30)
    assert page.locator('text=Confirm session accessibility').count()>=1
    # Communications channel editors are distinct and preserve content.
    page.evaluate("location.hash='#admin/communications'");page.wait_for_timeout(30)
    page.locator('[data-comms-channel="SMS"]').click();page.wait_for_timeout(30)
    assert page.locator('[data-comms-sms]').count()==1
    page.locator('[data-comms-sms]').fill('Tomorrow: Future of Events 2025. View your programme at pcue.co/e/foe25')
    assert 'Tomorrow:' in page.locator('[data-comms-sms]').input_value()
    # Communications fail closed until the critical footer validation is resolved.
    page.evaluate("location.hash='#admin/communications'");page.wait_for_timeout(30)
    page.locator('[data-open-send]').first.click();assert page.locator('[data-final-send]').count()==0;page.locator('[data-close]').first.click()
    page.locator('[data-fix-validation]').click();page.wait_for_timeout(30);page.locator('[data-open-send]').first.click();assert page.locator('[data-final-send]').count()==1;page.locator('[data-close]').first.click()
    # Speaker portal profile, slide and supporting-asset actions persist.
    page.evaluate("location.hash='#speaker/dashboard'");page.wait_for_timeout(30)
    page.locator('[data-update-profile]').click();page.locator('#speaker-short-bio').fill('Event strategist and speaker.');page.locator('#speaker-bio').fill('Alex Morgan helps event teams create inclusive, evidence-based attendee experiences.');page.locator('#speaker-publish-profile').check();page.locator('[data-confirm-speaker-profile]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.speaker.profilePublished') is True
    page.locator('[data-upload-slides]').first.click();page.locator('#speaker-file').set_input_files({'name':'slides.pdf','mimeType':'application/pdf','buffer':b'%PDF demo'});page.locator('[data-confirm-speaker-upload]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.speaker.slidesUploaded') is True
    page.locator('[data-add-speaker-asset]').first.click();page.locator('#speaker-asset-file').set_input_files({'name':'session-logo.png','mimeType':'image/png','buffer':b'png'});page.locator('[data-confirm-speaker-asset]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.speaker.assets.length')==1
    # Integration actions generate a local dry-run preview and never fabricate provider success.
    page.evaluate("location.hash='#admin/integrations'");page.wait_for_timeout(30)
    page.locator('[data-preview-integration]').first.click();page.wait_for_timeout(30)
    assert page.locator('text=No provider call will be made').count()==1
    page.locator('[data-generate-integration-preview]').click();page.wait_for_timeout(30)
    assert page.evaluate("state.integrations[0].activity.startsWith('Dry-run preview generated')") is True
    assert page.locator('text=sync completed').count()==0
    # Programme publication exposes the committed export formats.
    page.evaluate("location.hash='#admin/programme'");page.wait_for_timeout(30)
    assert page.locator('[data-export-programme]').count()==4
    # Speaker resources include a sandboxed embed and acknowledgement workflow.
    page.evaluate("location.hash='#speaker/resources'");page.wait_for_timeout(30)
    assert page.locator('iframe.resource-embed[sandbox]').count()==1
    if page.locator('[data-ack-resource]').count():
        page.locator('[data-ack-resource]').click();page.wait_for_timeout(30)
    assert page.evaluate("state.speaker.resourceAcknowledgements.includes('speaker-handbook')") is True
    # Organisation settings persist rather than displaying a success-only placeholder.
    page.evaluate("location.hash='#admin/settings'");page.wait_for_timeout(30)
    page.locator('[data-setting="organisation"]').fill('Future Events Association Updated');page.locator('[data-save-settings]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.settings.organisation')=='Future Events Association Updated'
    # Reusable fields are real form-definition state.
    page.evaluate("location.hash='#admin/submissions/form'");page.wait_for_timeout(30)
    before_fields=page.evaluate('state.form.fields.length');page.locator('[data-create-reusable]').click();page.locator('#reuse-name').fill('Travel requirements');page.locator('[data-create-reuse]').click();page.wait_for_timeout(30)
    assert page.evaluate('state.form.fields.length')==before_fields+1
    # Common-laptop layouts avoid page-level horizontal overflow.
    page.set_viewport_size({'width':1280,'height':720})
    for route in ['#admin/command','#admin/review','#admin/schedule','#admin/communications','#admin/tasks']:
        page.evaluate("route=>location.hash=route",route);page.wait_for_timeout(30)
        overflow=page.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth')
        if overflow>3: errors.append(f'{route}: page-level horizontal overflow {overflow}px at 1280px')
    browser.close()
print('browser check errors:',errors)
if errors: raise SystemExit(1)
