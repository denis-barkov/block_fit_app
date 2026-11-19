import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIdentity,comparisonBriefFilename } from '../../config/app';
import { mapArea } from '../../config/map-area';
import { feedback, pilot } from '../../config/settings';

const credentials=()=>{
  const path=process.env.BLOCKFIT_STORE;
  if(!path)throw new Error('Run make test-browser to initialize an isolated database.');
  return JSON.parse(readFileSync(join(path,'demo-accounts.json'),'utf8')) as {
    staff:{email:string;password:string};resident:{email:string;password:string};
  };
};
const passphrase='a synthetic resident test passphrase';
async function allowFallback(page:Page) {
  await page.route(`${new URL(mapArea.styleUrl).origin}/**`,route=>route.abort());
}
async function noPageOverflow(page:Page) {
  expect(await page.locator('html').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
}
test('public discovery keeps the map ahead of listings on smaller screens and supports fallback',async({page})=>{
  await allowFallback(page);
  await page.goto('/');
  await expect(page).toHaveTitle(appIdentity.name);
  await expect(page.getByRole('banner').getByRole('link',{name:appIdentity.name})).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText(appIdentity.name);
  await expect(page.getByRole('heading',{name:'Find outdoor fitness equipment.'})).toBeVisible();
  await expect(page.getByText('Map unavailable.',{exact:false})).toBeVisible();
  await page.getByLabel('Equipment type').selectOption('parallel');
  await page.getByRole('button',{name:/East court parallel bars/}).click();
  await expect(page.getByRole('article',{name:'Selected equipment'})).toContainText('Unverified');
  await page.getByLabel('Site or park name').fill('missing fixture');
  await page.getByRole('button',{name:'Find equipment',exact:true}).click();
  await expect(page.getByText('No matching equipment is listed.',{exact:false})).toBeVisible();
  const mapPanel=page.getByRole('region',{name:'Neighborhood map'});
  const listings=page.getByRole('region',{name:'Equipment listings'});
  const search=page.getByRole('button',{name:'Find equipment',exact:true});
  for (const width of [1440,1024,768,390]) {
    await page.setViewportSize({width,height:900});
    await noPageOverflow(page);
    const map=await mapPanel.boundingBox();
    const list=await listings.boundingBox();
    const filter=await search.boundingBox();
    expect(map!.y).toBeGreaterThan(filter!.y+filter!.height);
    if(width<1200) expect(map!.y+map!.height).toBeLessThan(list!.y);
    else {
      expect(map!.x).toBeGreaterThan(list!.x+list!.width);
      expect(map!.y).toBe(list!.y);
    }
  }
});
test('map pin and list share selection with an offline vector style',async({page})=>{
  await page.route(mapArea.styleUrl,route=>route.fulfill({json:{
    version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#dbece2'}}],
  }}));
  await page.goto('/');
  const map=page.getByLabel('Public equipment map');
  for(const width of [1440,768,390]) {
    await page.setViewportSize({width,height:900});
    await page.screenshot({path:test.info().outputPath(`public-map-${width}.png`)});
  }
  const bench=map.getByRole('button',{name:'Standalone sit-up bench'});
  await expect(bench).toBeVisible();
  await bench.click();
  await expect(page.getByRole('article',{name:'Selected equipment'})).toContainText('Standalone sit-up bench');
  await expect(bench).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:/West court pull-up bars.*Simulated verification/}).click();
  await expect(map.getByRole('button',{name:'West court pull-up bars'})).toHaveAttribute('aria-pressed','true');
  await expect(map.getByText('Brooklyn and Queens pin area')).toBeVisible();
  for (const width of [390,1440]) {
    await page.setViewportSize({width,height:900});
    await map.getByRole('button',{name:'Show all five boroughs'}).click();
    await expect(map.getByRole('button',{name:'Zoom out'})).toBeDisabled();
    await map.screenshot({path:test.info().outputPath(`nyc-extent-${width}.png`)});
    await map.getByRole('button',{name:`Show ${pilot.neighborhood} demo`}).click();
    await expect(map.getByRole('button',{name:'Zoom out'})).toBeEnabled();
  }
});
test('mobile registration preserves the selected category and persists the resident lifecycle',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await allowFallback(page);
  await page.goto('/');
  await page.getByLabel('Equipment type').selectOption('parallel');
  await page.getByRole('button',{name:/East court parallel bars/}).click();
  await expect(page.getByRole('article',{name:'Selected equipment'})).toContainText('East court parallel bars');
  await page.getByRole('button',{name:'Request this equipment nearby'}).click();
  await expect(page).toHaveURL(/\/login\?returnTo=/);
  const auth=page.getByRole('main');
  await auth.getByRole('button',{name:'Forgot password?'}).click();
  await expect(auth).toContainText('Never send your password.');
  await expect(auth.getByRole('link',{name:'Contact us'})).toHaveAttribute('href','mailto:contact@blockfit.example');
  await auth.getByRole('button',{name:'Back to sign in'}).click();
  await auth.getByRole('button',{name:'Create resident account'}).click();
  await auth.getByLabel('Display name').fill('Mobile test');
  await auth.getByLabel('Email').fill('browser-resident@blockfit.example');
  await auth.getByLabel('Password',{exact:true}).fill(passphrase);
  await auth.getByLabel('Confirm password').fill(passphrase);
  await auth.getByRole('button',{name:'Register'}).press('Enter');
  let dialog=page.getByRole('dialog',{name:'Save a private location'});
  await dialog.getByLabel('Location label (optional)').fill('Demo pin');
  await dialog.getByRole('checkbox',{name:'Use this saved location for new requests'}).check();
  await dialog.getByRole('button',{name:'Save location'}).press('Enter');
  dialog=page.getByRole('dialog',{name:'Request equipment nearby'});
  await expect(dialog.getByLabel('Equipment type')).toHaveValue('parallel');
  const requestHelp=dialog.getByRole('button',{name:'How your location is used'});
  await expect(dialog.getByText(/Planning uses a 200 m/)).toBeHidden();
  await requestHelp.press('Enter');
  await expect(dialog.getByText(/Planning uses a 200 m/)).toBeVisible();
  await requestHelp.press('Enter');
  await expect(dialog.getByText(/Planning uses a 200 m/)).toBeHidden();
  await dialog.getByLabel('Note (optional)').fill('Initial note');
  await dialog.getByRole('button',{name:'Review request'}).press('Enter');
  await expect(dialog.getByRole('heading',{name:'Review your request'})).toBeFocused();
  await page.clock.install();
  await dialog.getByRole('button',{name:'Record request'}).press('Enter');
  const recorded=page.getByText('Request recorded.',{exact:true});
  await expect(recorded).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs);
  await expect(recorded).toHaveCount(0);
  await expect(page.getByText('Initial note')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Initial note')).toBeVisible();
  const account=page.getByRole('button',{name:'Account',exact:true});
  await expect(account).toHaveText('MT');
  await account.press('Enter');
  const profile=page.getByRole('dialog',{name:'Account'});
  await expect(profile).toContainText('Mobile test');
  await expect(profile).toContainText('browser-resident@blockfit.example');
  await expect(profile.getByRole('button',{name:'Change password'})).toBeVisible();
  await profile.screenshot({path:test.info().outputPath('resident-account.png')});
  await page.keyboard.press('Escape');
  await expect(profile).toHaveCount(0);
  await expect(account).toBeFocused();
  await page.getByRole('button',{name:'Edit request'}).click();
  dialog=page.getByRole('dialog');
  await dialog.getByLabel('Note (optional)').fill('Edited note');
  await dialog.getByRole('button',{name:'Review request'}).click();
  await dialog.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByText('Edited note')).toBeVisible();
  await page.getByRole('button',{name:'Withdraw',exact:true}).click();
  await expect(page.getByText('Withdrawn',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Restore request'}).click();
  await expect(page.getByText('Request restored.')).toBeVisible();
  await page.getByRole('button',{name:'Change saved location'}).click();
  dialog=page.getByRole('dialog',{name:'Change saved location'});
  const preference=dialog.getByRole('checkbox',{name:'Use this saved location for new requests'});
  await preference.uncheck();
  await dialog.getByRole('button',{name:'Save location'}).press('Enter');
  await expect(page.getByText('New requests require you to choose a location.')).toBeVisible();
  await page.getByRole('button',{name:'New request'}).click();
  await expect(preference).not.toBeChecked();
  await dialog.getByLabel('Latitude').fill('40.714');
  await dialog.getByLabel('Longitude').fill('-74.008');
  await expect(dialog.getByText('Choose a pin in Brooklyn and Queens.')).toBeVisible();
  await dialog.getByRole('button',{name:'Move location'}).click();
  await expect(dialog.getByRole('button',{name:'Confirm move'})).toHaveCount(0);
  await dialog.getByLabel('Latitude').fill('40.5756');
  await dialog.getByLabel('Longitude').fill('-73.9805');
  await dialog.getByLabel('Location label (optional)').fill('Coney Island fixture');
  await dialog.getByRole('button',{name:'Move location'}).click();
  await expect(dialog).toContainText('1 active request');
  await expect(dialog.getByRole('heading',{name:'Move to this location?'})).toBeFocused();
  await dialog.getByRole('button',{name:'Back',exact:true}).click();
  await expect(dialog.getByLabel('Latitude')).toHaveValue('40.5756');
  await dialog.getByRole('button',{name:'Move location'}).click();
  await dialog.getByRole('button',{name:'Confirm move'}).click();
  await expect(page.getByText('Coney Island fixture')).toBeVisible();
  await page.getByRole('button',{name:'Remove saved location'}).click();
  dialog=page.getByRole('dialog',{name:'Remove saved location'});
  await expect(dialog).toContainText('Withdraw the active requests');
  await expect(dialog.getByRole('button',{name:'Confirm removal'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('button',{name:'Withdraw',exact:true}).click();
  await expect(page.getByText('Withdrawn',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Remove saved location'}).click();
  await dialog.getByRole('button',{name:'Confirm removal'}).click();
  await expect(page.getByText('No location saved yet.')).toBeVisible();
  await expect(page.getByText('Withdrawn',{exact:true})).toBeVisible();
  await noPageOverflow(page);
  await page.getByRole('button',{name:'Sign out'}).click();
  await expect(page.getByRole('heading',{name:'Find outdoor fitness equipment.'})).toBeVisible();
});
test('staff can compare and download on desktop and manage inventory on mobile',async({page})=>{
  await page.route(mapArea.styleUrl,route=>route.fulfill({json:{
    version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#dbece2'}}],
  }}));
  const {staff}=credentials();
  await page.goto('/city');
  await expect(page).toHaveURL(/\/staff\/login/);
  await expect(page.getByRole('heading',{name:'City staff sign in'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create resident account'})).toHaveCount(0);
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password',{exact:true}).fill(staff.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).press('Enter');
  await expect(page.getByRole('heading',{name:'Where could investment improve access?'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Staff navigation'})).toContainText('Manage inventory');
  await expect(page.getByText('My requests',{exact:true})).toHaveCount(0);
  const map=page.getByRole('region',{name:'Staff coverage map'});
  const assumptions=page.getByRole('form',{name:/Equipment and assumptions/});
  const selectedOnly=page.getByRole('checkbox',{name:'Selected sites only',exact:true});
  const compareSites=page.getByRole('button',{name:'Compare sites',exact:true});
  await expect(map).toBeVisible();
  for(const width of [1440,768,390]) {
    await page.setViewportSize({width,height:844});
    if(width<1440) {
      const form=await assumptions.boundingBox();
      expect((await map.boundingBox())!.y).toBeGreaterThan(form!.y+form!.height);
    }
    const checkbox=await selectedOnly.boundingBox();
    const button=await compareSites.boundingBox();
    expect(checkbox!.x+checkbox!.width).toBeLessThan(button!.x);
    expect(Math.abs(checkbox!.y+checkbox!.height/2-button!.y-button!.height/2)).toBeLessThan(2);
  }
  await selectedOnly.press('Space');
  await expect(compareSites).toBeDisabled();
  await expect(selectedOnly).toHaveAccessibleDescription('Select at least one site or uncheck Selected sites only.');
  await selectedOnly.press('Space');
  await map.screenshot({path:test.info().outputPath('staff-map-mobile.png')});
  await page.setViewportSize({width:1440,height:1000});
  const account=page.getByRole('button',{name:'Account',exact:true});
  await expect(account).toHaveText(/^[A-Z]{1,2}$/);
  await account.press('Enter');
  const profile=page.getByRole('dialog',{name:'Account'});
  await expect(profile).toContainText('City staff');
  await expect(profile).toContainText(staff.email);
  await expect(profile.getByRole('button',{name:'Change password'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(profile).toHaveCount(0);
  await expect(account).toBeFocused();
  await map.getByRole('button',{name:/Central courtyard A/}).click();
  await expect(page.getByRole('article',{name:'Candidate details'})).toContainText('Central courtyard A');
  await page.getByRole('button',{name:'Add to combination'}).click();
  await page.getByRole('checkbox',{name:'Central courtyard B'}).check();
  await selectedOnly.check();
  await compareSites.click();
  const combination=page.getByRole('row',{name:/Central courtyard A.*Central courtyard B/});
  await expect(combination).toContainText('Over budget');
  const optionCount=page.getByRole('status',{name:'Comparison option count'});
  await expect(optionCount).toHaveText('3 options');
  const otherSite=page.getByRole('table').getByRole('button',{name:/West paved court conversion/});
  await expect(otherSite).toHaveCount(0);
  await selectedOnly.uncheck();
  await compareSites.click();
  await expect(otherSite).toBeVisible();
  await expect(optionCount).toHaveText('8 options');
  await expect(combination).toContainText('in overlapping radii, counted once');
  await page.getByRole('table').getByRole('button',{name:/Central courtyard B/}).press('Enter');
  await expect(map.getByRole('button',{name:/Central courtyard B/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('article',{name:'Candidate details'})).toContainText('Central courtyard B');
  await expect(page.getByText('already covered',{exact:false}).first()).toBeVisible();
  const eligible=await map.locator('[data-kind=equipment]').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
  const covered=await map.locator('[data-kind=synthetic][data-covered=true]').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().toJSON()));
  expect(covered.length).toBeGreaterThan(0);
  expect(covered.every(point=>eligible.some(pin=>Math.hypot(point.x+point.width/2-pin.x-pin.width/2,
    point.y+point.height/2-pin.y-pin.height/2)<70))).toBe(true);
  await map.screenshot({path:test.info().outputPath('staff-map.png')});
  await page.getByRole('button',{name:'Request AI explanation'}).click();
  await expect(page.getByRole('alert')).toContainText('AI is unavailable.');
  await expect(combination).toContainText('Over budget');
  const mockExplanation=async(route:import('@playwright/test').Route)=>{
    await route.fulfill({json:{
      summary:'Central courtyard A leads on modeled lifecycle cost per additional requester.',
      tradeoffs:'The combination reaches more of the recorded demand. Its higher upfront cost puts it over budget.',
      checks:'Confirm maintenance assumptions before proceeding. <img src=x onerror=alert(1)>',
      highlightedOptionIds:['demo-a'],referencedOptionIds:['demo-a','demo-a,demo-b'],
    }});
  };
  await page.route('**/api/staff/explain',mockExplanation);
  await page.getByRole('button',{name:'Request AI explanation'}).click();
  const explanation=page.getByRole('article',{name:'AI explanation'});
  await expect(explanation).toContainText('Central courtyard A leads');
  await expect(explanation).toContainText('<img src=x onerror=alert(1)>');
  await expect(explanation.locator('img')).toHaveCount(0);
  const comparisonPanel=page.getByRole('region',{name:/Compare investment options/});
  await expect(comparisonPanel).not.toContainText('Export for review');
  const comparisonHelp=comparisonPanel.getByRole('button',{name:'How this comparison works'});
  await comparisonHelp.press('Enter');
  await expect(comparisonPanel.getByText(/Upfront budget fit is separate/)).toBeVisible();
  await comparisonHelp.press('Enter');
  await expect(comparisonPanel.getByText(/Upfront budget fit is separate/)).toBeHidden();
  for(const width of [1440,768,390]) {
    await page.setViewportSize({width,height:844});
    await noPageOverflow(page);
    const action=await comparisonPanel.getByRole('button',{name:'Request AI explanation'}).boundingBox();
    const card=await explanation.boundingBox();
    const table=await comparisonPanel.getByRole('table').boundingBox();
    expect(card!.y).toBeGreaterThan(action!.y+action!.height);
    expect(card!.y+card!.height).toBeLessThan(table!.y);
    if(width>=768) expect(Math.abs(card!.x+card!.width-action!.x-action!.width)).toBeLessThan(2);
    if(width===1440) {
      expect(Math.abs(card!.x-table!.x)).toBeLessThan(2);
      expect(Math.abs(card!.width-table!.width)).toBeLessThan(2);
    }
    await comparisonPanel.screenshot({path:test.info().outputPath(`comparison-${width}.png`)});
  }
  await page.getByLabel('Planning horizon (years)').fill('12');
  await expect(explanation).toHaveCount(0);
  await page.getByRole('button',{name:'Apply assumptions'}).click();
  await expect(page.getByRole('button',{name:'Request AI explanation'})).toBeEnabled();
  await expect(explanation).toHaveCount(0);
  await page.clock.install();
  const downloadBrief=page.getByRole('button',{name:'Download brief'});
  const confirmation=page.getByText('Comparison brief downloaded.',{exact:true});
  const download=page.waitForEvent('download');
  await downloadBrief.click();
  expect((await download).suggestedFilename()).toBe(comparisonBriefFilename);
  await expect(confirmation).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs/2);
  await expect(confirmation).toBeVisible();
  const repeated=page.waitForEvent('download');
  await downloadBrief.click();
  await repeated;
  await expect(confirmation).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs/2+100);
  await expect(confirmation).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs/2);
  await expect(confirmation).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  await selectedOnly.check();
  await page.getByRole('button',{name:'Select all available sites'}).click();
  await page.getByRole('checkbox',{name:'Central courtyard A'}).uncheck();
  await compareSites.click();
  await expect(optionCount).toHaveText('6 options');
  await expect(combination).toHaveCount(0);
  await noPageOverflow(page);
  await page.getByRole('link',{name:'View public site'}).click();
  await expect(page.getByRole('link',{name:'Return to City workspace'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Account',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Request .*equipment/})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'My requests'})).toHaveCount(0);
  await page.getByRole('link',{name:'Return to City workspace'}).click();
  await page.getByRole('link',{name:'Manage inventory'}).click();
  await page.getByRole('button',{name:'Add equipment'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Name',{exact:true}).fill('Browser equipment');
  await dialog.getByRole('button',{name:'Save equipment'}).click();
  await expect(page.getByText('Inventory saved.')).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Edit Browser equipment'}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('Browser equipment revised');
  await dialog.getByRole('button',{name:'Save equipment'}).click();
  await page.getByRole('button',{name:'Archive Browser equipment revised'}).click();
  await dialog.getByRole('button',{name:'Confirm archive'}).click();
  await expect(page.getByRole('button',{name:'Edit Browser equipment revised'})).toHaveCount(0);
  await page.getByRole('button',{name:'Candidate sites',exact:true}).click();
  await page.getByRole('button',{name:'Add candidate'}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('Browser candidate');
  await dialog.getByLabel('Replacement plan').selectOption('none');
  await dialog.getByRole('button',{name:'Save candidate'}).click();
  await expect(page.getByRole('button',{name:'Edit Browser candidate'})).toBeVisible();
  await page.reload();
  await page.getByRole('button',{name:'Candidate sites',exact:true}).click();
  await page.getByRole('button',{name:'Edit Browser candidate'}).click();
  await dialog.getByLabel('Name',{exact:true}).fill('Browser candidate revised');
  await dialog.getByRole('button',{name:'Save candidate'}).click();
  await page.getByRole('button',{name:'Archive Browser candidate revised'}).click();
  await dialog.getByRole('button',{name:'Confirm archive'}).click();
  await expect(page.getByRole('button',{name:'Edit Browser candidate revised'})).toHaveCount(0);
  await noPageOverflow(page);
});


test('ordinary login sends staff to the workspace and back navigation respects logout',async({page})=>{
  await allowFallback(page);
  const {staff}=credentials();
  await page.goto('/login?returnTo=https%3A%2F%2Fexample.invalid%2F');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password',{exact:true}).fill(staff.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(/\/staff$/);
  await page.getByRole('link',{name:'Manage inventory'}).click();
  await expect(page).toHaveURL(/\/staff\/inventory$/);
  await page.getByRole('button',{name:'Sign out'}).click();
  await expect(page.getByRole('heading',{name:'City staff sign in'})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading',{name:'City staff sign in'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Where could investment improve access?'})).toHaveCount(0);
});

test('resident sign-in at the staff entry shows a role mismatch and survives mobile navigation',async({page})=>{
  await allowFallback(page);
  const {resident}=credentials();
  await page.setViewportSize({width:390,height:844});
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(resident.email);
  await page.getByLabel('Password',{exact:true}).fill(resident.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).press('Enter');
  await expect(page.getByRole('heading',{name:'Staff access required'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Manage inventory'})).toHaveCount(0);
  await page.getByRole('link',{name:'Resident sign-in'}).press('Enter');
  await expect(page.getByRole('heading',{name:'My requests'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Public navigation'})).toContainText('My requests');
  await expect(page.getByRole('link',{name:'City staff sign in'})).toHaveCount(0);
  await noPageOverflow(page);
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Resident sign in'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'My requests'})).toHaveCount(0);
});

test('public distance and copy work anonymously and a resident explicitly generates both helper modes',async({page})=>{
  await page.route(mapArea.styleUrl,route=>route.fulfill({json:{
    version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#dbece2'}}],
  }}));
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined}));
  const {resident}=credentials();
  let calls=0;
  await page.route('**/api/resident/travel',async route=>{
    calls++;
    const input=route.request().postDataJSON();
    expect(input.category).toBe('pull-up');
    expect(input.origin.lat).toBeGreaterThan(40.5);
    await route.fulfill({json:{cached:calls===1,evidence:'unavailable',
      options:[{id:input.target??'demo-v3-east-path-bar',reason:'distance'}]}});
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.getByLabel('Equipment type').selectOption('pull-up');
  const chosen=page.getByRole('article',{name:'Selected equipment'});
  await expect(chosen.getByRole('link',{name:'View pin in Google Maps'})).toHaveAttribute('href',/google\.com\/maps\/search/);
  await page.clock.install();
  await chosen.getByRole('button',{name:'Copy location'}).click();
  const manualCopy=chosen.getByLabel('Select and copy this location');
  await expect(manualCopy).toHaveValue(/illustrative demo location/);
  await page.clock.fastForward(feedback.confirmationMs);
  await expect(manualCopy).toBeVisible();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}}));
  await chosen.getByRole('button',{name:'Copy location'}).click();
  const copied=chosen.getByText('Location copied.',{exact:true});
  await expect(copied).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs);
  await expect(copied).toHaveCount(0);
  await page.getByRole('button',{name:'Set reference pin'}).click();
  const map=page.getByRole('region',{name:'Public equipment map'});
  await map.locator('canvas').click({position:{x:155,y:157}});
  const distanceHelp=page.getByRole('button',{name:'How distances are measured'});
  const distanceText=page.getByText('Straight-line distance; the actual journey may be longer.');
  await expect(distanceHelp).toHaveAttribute('aria-expanded','false');
  await expect(distanceText).toBeHidden();
  await distanceHelp.press('Enter');
  await expect(distanceHelp).toHaveAttribute('aria-expanded','true');
  await page.clock.fastForward(feedback.confirmationMs);
  await expect(distanceText).toBeVisible();
  await distanceHelp.press('Space');
  await expect(distanceText).toBeHidden();
  await expect(page.getByRole('region',{name:'Equipment listings'}).getByText(/Approx\. distance/).first()).toBeVisible();
  await page.getByRole('button',{name:/Explore travel options/}).click();
  let panel=page.getByRole('dialog',{name:'Help me choose'});
  await panel.getByRole('button',{name:/Sign in or create/}).click();
  expect(page.url()).not.toMatch(/40\.7|-73\./);
  await page.getByLabel('Email').fill(resident.email);
  await page.getByLabel('Password',{exact:true}).fill(resident.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).press('Enter');
  await expect(panel).toBeVisible();
  expect(calls).toBe(0);
  const travelHelp=panel.getByRole('button',{name:'About travel suggestions'});
  const travelNotice=panel.getByText(/Suggestions use mapped landmarks/);
  await expect(travelNotice).toBeHidden();
  await travelHelp.click();
  await expect(travelNotice).toBeVisible();
  await travelHelp.click();
  await expect(travelNotice).toBeHidden();
  await noPageOverflow(page);
  const shortlistButton=panel.getByRole('button',{name:'Generate suggestions',exact:true});
  await shortlistButton.click();
  const suggestion=panel.getByText('Compare this location using its straight-line distance from your pin.');
  await expect(suggestion).toBeVisible();
  const reused=panel.getByText('Reused a saved suggestion for this search.');
  await expect(reused).toBeVisible();
  await page.clock.fastForward(feedback.confirmationMs);
  await expect(reused).toHaveCount(0);
  await expect(suggestion).toBeVisible();
  await noPageOverflow(page);
  await panel.screenshot({path:test.info().outputPath('travel-phone.png')});
  await expect(panel.getByRole('button',{name:'Copy location'})).toHaveCount(0);
  await expect(panel.getByRole('link',{name:/Google Maps|Apple Maps/})).toHaveCount(0);
  await panel.getByRole('button',{name:'Show on map East green pull-up station'}).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Neighborhood map'})).toBeFocused();
  await expect(chosen).toContainText('East green pull-up station');
  await expect(chosen.getByText('Compare this location using its straight-line distance from your pin.')).toBeVisible();
  await expect(chosen.getByRole('link',{name:'View pin in Google Maps'})).toBeVisible();
  await expect(chosen.getByRole('button',{name:'Copy location'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Equipment listings'}).getByRole('button',{name:/East green pull-up station/}))
    .toHaveAttribute('aria-pressed','true');
  const pin=map.getByRole('button',{name:'East green pull-up station'});
  await expect(pin).toHaveAttribute('aria-pressed','true');
  await expect.poll(async()=>{
    const marker=await pin.boundingBox();
    const canvas=await map.locator('canvas').boundingBox();
    if(!marker||!canvas)return Infinity;
    return Math.hypot(marker.x+marker.width/2-canvas.x-canvas.width/2,marker.y+marker.height/2-canvas.y-canvas.height/2);
  }).toBeLessThan(4);
  expect(calls).toBe(1);
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('region',{name:'Equipment listings'}).getByRole('button',{name:/West court pull-up bars/}).click();
  await chosen.getByRole('button',{name:'Explore this location'}).click();
  panel=page.getByRole('dialog',{name:'Explore this location'});
  await panel.getByRole('button',{name:'Generate suggestion',exact:true}).click();
  await expect(panel.getByText('No landmarks found in the inspected map data.')).toBeVisible();
  expect(calls).toBe(2);
  await panel.screenshot({path:test.info().outputPath('travel-desktop.png')});
});

test('staff manages the catalog and corrects a resident proposal on narrow screens',async({page,browser,baseURL})=>{
  const {staff}=credentials();
  const resident=await browser.newPage({baseURL,viewport:{width:390,height:844},hasTouch:true});
  const visitor=await browser.newPage({baseURL,viewport:{width:768,height:900}});
  const proposed='Grip ladderz';
  const approved='Grip ladders';
  try {
    await allowFallback(resident);
    await allowFallback(visitor);
    await page.goto('/staff/equipment-types');
    await expect(page).toHaveURL(/\/staff\/login\?returnTo=/);
    await page.getByLabel('Email').fill(staff.email);
    await page.getByLabel('Password',{exact:true}).fill(staff.password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('link',{name:'Equipment types'})).toHaveAttribute('aria-current','page');
    await page.getByRole('button',{name:'Add type'}).click();
    let dialog=page.getByRole('dialog');
    await dialog.getByLabel('Type name').fill('Incline ladders');
    await dialog.getByLabel('Description (optional)').fill('Illustrative generic type');
    await dialog.getByRole('button',{name:'Create type'}).click();
    await expect(page.getByText('Equipment type added.')).toBeVisible();
    await page.getByRole('button',{name:'Edit Incline ladders'}).click();
    await dialog.getByLabel('Type name').fill('Incline training ladders');
    await dialog.getByRole('checkbox',{name:/same kind of equipment/}).check();
    await dialog.getByRole('button',{name:'Save changes'}).click();
    await expect(page.getByRole('button',{name:'Edit Incline training ladders'})).toBeVisible();
    await visitor.goto('/');
    await expect(visitor.getByLabel('Equipment type').getByRole('option',{name:'Incline training ladders'})).toHaveCount(1);

    const registered=await resident.request.post('/api/auth/sign-up/email',{
      headers:{Origin:baseURL!},data:{name:'Catalog browser fixture',email:'catalog-browser@blockfit.example',
        password:passphrase,confirmation:passphrase},
    });
    expect(registered.status()).toBe(200);
    await resident.goto('/requests');
    await expect(resident.getByRole('link',{name:'Equipment types'})).toHaveCount(0);
    await resident.getByRole('button',{name:'New request'}).tap();
    const residentDialog=resident.getByRole('dialog');
    await residentDialog.getByRole('button',{name:'Save location'}).tap();
    await residentDialog.getByRole('button',{name:'Suggest another type'}).tap();
    await residentDialog.getByLabel('Proposed equipment type').fill('pull-up');
    await expect(residentDialog.getByRole('button',{name:'Use Pull-up bars'})).toBeVisible();
    await residentDialog.getByLabel('Proposed equipment type').fill(proposed);
    await residentDialog.getByLabel('Type description (optional)').fill('Generic synthetic apparatus');
    await residentDialog.getByLabel('Note (optional)',{exact:true}).fill('Request note kept through review');
    await residentDialog.getByRole('button',{name:'Review suggestion'}).tap();
    await expect(residentDialog.getByRole('heading',{name:'Review your type suggestion'})).toBeFocused();
    await residentDialog.getByRole('button',{name:'Submit type suggestion'}).tap();
    await expect(resident.getByText('Awaiting type review',{exact:true})).toBeVisible();
    await expect(resident.getByText('Recorded',{exact:true})).toHaveCount(0);
    await expect(visitor.getByLabel('Equipment type').getByRole('option',{name:proposed})).toHaveCount(0);

    await page.getByRole('button',{name:'Proposals',exact:true}).click();
    await page.setViewportSize({width:390,height:844});
    const help=page.getByRole('button',{name:'About type review'});
    await help.press('Enter');
    await expect(help).toHaveAttribute('aria-expanded','true');
    await help.press('Escape');
    await expect(help).toHaveAttribute('aria-expanded','false');
    await expect(help).toBeFocused();
    await page.screenshot({path:test.info().outputPath('catalog-proposals-390.png'),animations:'disabled'});
    await noPageOverflow(page);
    await page.getByRole('button',{name:'Review '+proposed}).click();
    dialog=page.getByRole('dialog',{name:'Review type proposal'});
    await dialog.getByLabel('Approved type name').fill(approved);
    await dialog.getByRole('button',{name:'Confirm approval'}).click();
    await expect(page.getByText('Review decision saved.')).toBeVisible();
    await expect(page.getByText('No proposals with this status.')).toBeVisible();
    await resident.reload();
    await expect(resident.getByText('Approved as '+approved+'.')).toBeVisible();
    await resident.getByRole('link',{name:'View equipment request'}).tap();
    await expect(resident.locator('article:target')).toContainText('Request note kept through review');
    await noPageOverflow(resident);
    const published=(await (await page.request.get('/api/catalog')).json()).find((item:{name:string})=>item.name===approved);
    const added=await page.request.post('/api/staff/inventory/equipment',{
      headers:{Origin:baseURL!},data:{...pilot.center,category:published.id,name:'Synthetic grip installation',parkId:null,
        condition:'usable',access:'public',source:'Browser fixture',verifiedOn:'2026-01-01',visible:true},
    });
    expect(added.status()).toBe(201);
    await visitor.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(visitor.getByLabel('Equipment type').getByRole('option',{name:approved})).toHaveCount(1);
    await visitor.getByLabel('Equipment type').selectOption(published.id);
    await expect(visitor.getByRole('article',{name:'Selected equipment'})).toContainText('Synthetic grip installation');

    await page.getByRole('button',{name:'Types',exact:true}).click();
    await page.getByLabel('Search types').fill('Grip');
    await page.getByRole('button',{name:'Deactivate '+approved}).click();
    await expect(page.getByRole('dialog')).toContainText('Existing records remain.');
    await page.getByRole('button',{name:'Confirm deactivation'}).click();
    await expect(page.getByRole('button',{name:'Reactivate '+approved})).toBeVisible();
    await visitor.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(visitor.getByLabel('Equipment type').getByRole('option',{name:approved})).toHaveCount(0);
    await expect(visitor.getByRole('article',{name:'Selected equipment'})).toContainText('This type is unavailable for new requests and travel suggestions.');
    await expect(visitor.getByRole('article',{name:'Selected equipment'})).toContainText('usable');
    await resident.reload();
    await expect(resident.getByText('Type currently unavailable',{exact:true})).toBeVisible();
    await expect(resident.getByRole('button',{name:'Withdraw',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Reactivate '+approved}).click();
    await page.getByRole('button',{name:'Confirm reactivation'}).click();
    await expect(page.getByRole('button',{name:'Deactivate '+approved})).toBeVisible();
    await page.setViewportSize({width:1440,height:1000});
    await noPageOverflow(page);
    await page.screenshot({path:test.info().outputPath('catalog-types-1440.png'),animations:'disabled'});
  } finally {
    await Promise.all([resident.close(),visitor.close()]);
  }
});

test('staff saves a goal, evaluates and filters options, and clears the goal without changing inputs',async({page,browser,baseURL})=>{
  const {staff}=credentials();
  await allowFallback(page);
  await page.goto('/staff');
  await page.getByLabel('Email').fill(staff.email);
  await page.getByLabel('Password',{exact:true}).fill(staff.password);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  const table=page.getByRole('table');
  await expect(table).toBeVisible();
  const optionCount=page.getByRole('status',{name:'Comparison option count'});
  await expect(optionCount).toHaveText('7 options');
  const context=await browser.newPage({baseURL});
  try {
    await allowFallback(context);
    await context.goto('/staff');
    await context.getByLabel('Email').fill(staff.email);
    await context.getByLabel('Password',{exact:true}).fill(staff.password);
    await context.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(context.getByRole('combobox',{name:'Program goal',exact:true})).toBeEnabled();

    let evaluations=0,explanations=0;
    let explanationFilter='';
    let explanationOrder='';
    let holdExplanation:Promise<void>|undefined;
    let clarify=false;
    let cachedPreview:{goal:{id:string;version:number}}|undefined;
    await page.route('**/api/staff/goals/preview',async route=>{
      const goal=route.request().postDataJSON().goal;
      if(cachedPreview?.goal.id===goal.id&&cachedPreview?.goal.version===goal.version) {
        await route.fulfill({json:cachedPreview});
      } else await route.continue();
    });
    await page.route('**/api/staff/goals/evaluate',async route=>{
      evaluations++;
      const request=route.request().postDataJSON();
      const compare=await page.request.post('/api/staff/compare',{headers:{Origin:baseURL!},data:request.scenario});
      const comparison=await compare.json() as {options:{ids:string[]}[]};
      const prior=await page.request.post('/api/staff/goals/preview',{headers:{Origin:baseURL!},data:request});
      const preview=await prior.json();
      const delivery=preview.goal.name==='Delivery readiness';
      const response={...preview,evaluationKey:'a'.repeat(64),evaluation:{clarification:clarify?'What disturbance is acceptable?':null,
        assessments:clarify?[]:comparison.options.map((option,index)=>({id:[...option.ids].sort().join(','),
          fit:(delivery?option.ids[0]==='demo-v3-east-gate-candidate':index===0)?'strong':'partial',
          reason:delivery?'The delivery goal prioritizes the confirmed inspection slot.':'The disruption goal prioritizes avoiding excavation.',
          evidence:['s1'],missing:['Confirm staging access'],conflict:null}))}};
      if(!delivery)cachedPreview=response;
      await route.fulfill({json:response});
    });
    await page.route('**/api/staff/explain',async route=>{
      explanations++;
      const goal=route.request().postDataJSON().goal;
      explanationFilter=goal?.filter;
      explanationOrder=goal?.order;
      await holdExplanation;
      await route.fulfill({json:{summary:goal?'An existing pad avoids excavation.':'Compare modeled coverage and lifecycle costs.',tradeoffs:'Review the modeled costs.',
        checks:'Confirm the estimates.',highlightedOptionIds:[],referencedOptionIds:[]}});
    });
    const budget=page.getByLabel('Upfront budget (USD)');
    await budget.fill('27000');
    await page.getByRole('button',{name:'Apply assumptions'}).click();
    await expect(table).toBeVisible();
    await page.getByRole('button',{name:'Manage goals'}).click();
    const editor=page.getByRole('dialog',{name:'Manage program goals'});
    await editor.getByLabel('Short name').fill('Low disruption');
    await editor.getByLabel('Description').fill('Favor straightforward mounting and limited disruption.');
    await editor.getByLabel('Earliest project start (optional)').fill('2027-03-01');
    await editor.getByLabel('Target completion (optional)').fill('2027-05-01');
    await editor.getByLabel('Search equipment types').fill('Pull-up');
    await editor.getByRole('checkbox',{name:'Pull-up bars'}).check();
    await editor.getByRole('button',{name:'Close dialog'}).press('Escape');
    await expect(editor.getByText('You have unsaved changes.',{exact:false})).toBeVisible();
    await editor.getByRole('button',{name:'Keep editing'}).click();
    await editor.getByRole('button',{name:'Save goal'}).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('combobox',{name:'Program goal',exact:true}).locator('option:checked')).toHaveText('Low disruption');
    await expect(context.getByRole('combobox',{name:'Program goal',exact:true})).toHaveValue('');
    await expect(table.getByRole('columnheader',{name:/Goal fit/})).toHaveCount(0);
    await expect(page.getByLabel('Filter by goal fit')).toHaveCount(0);
    await expect(page.getByLabel('Option ordering')).toHaveCount(0);
    await expect(page.getByRole('region',{name:'Goal review'})).toContainText('Start on or after 2027-03-01');
    expect(evaluations).toBe(0);
    expect(explanations).toBe(0);
    await page.getByRole('button',{name:'Request AI explanation'}).click();
    await expect(page.getByRole('article',{name:'AI explanation'})).toContainText('Compare modeled coverage and lifecycle costs.');
    expect(explanationFilter).toBeUndefined();
    expect(explanationOrder).toBeUndefined();
    await page.getByRole('button',{name:'Evaluate goal'}).click();
    await expect(page.getByLabel('Option ordering')).toHaveValue('fit');
    await expect(table.getByRole('columnheader',{name:/Goal fit/})).toBeVisible();
    await expect(page.getByRole('article',{name:'AI explanation'})).toHaveCount(0);
    const hint=table.getByRole('button',{name:/Goal evidence for/}).first();
    await hint.press('Enter');
    await expect(hint).toHaveAttribute('aria-expanded','true');
    await expect(table.getByText('The disruption goal prioritizes avoiding excavation.').first()).toBeVisible();
    await hint.press('Escape');
    await expect(hint).toHaveAttribute('aria-expanded','false');
    await expect(hint).toBeFocused();
    expect(evaluations).toBe(1);
    expect(explanations).toBe(1);
    await page.screenshot({path:test.info().outputPath('goal-table-1440.png'),animations:'disabled',fullPage:true});
    await page.getByLabel('Filter by goal fit').selectOption('strong');
    await expect(page.getByText('No options match this filter.',{exact:false})).toBeVisible();
    await page.getByLabel('Option ordering').selectOption('fit');
    await page.getByRole('button',{name:'Request AI explanation'}).click();
    await expect(page.getByRole('heading',{name:'AI explanation'})).toBeVisible();
    expect(explanationFilter).toBe('strong');
    expect(explanationOrder).toBe('fit');
    expect(evaluations).toBe(1);
    expect(explanations).toBe(2);
    await page.getByLabel('Option ordering').selectOption('baseline');
    await expect(page.getByRole('heading',{name:'AI explanation'})).toHaveCount(0);
    await page.getByLabel('Option ordering').selectOption('fit');
    await expect(page.getByRole('heading',{name:'AI explanation'})).toHaveCount(0);
    await page.getByLabel('Filter by goal fit').selectOption('information');
    await expect(page.getByRole('heading',{name:'AI explanation'})).toHaveCount(0);
    await expect(table).toBeVisible();
    const pause=Promise.withResolvers<void>();
    holdExplanation=pause.promise;
    const inFlight=page.waitForRequest('**/api/staff/explain');
    await page.getByRole('button',{name:'Request AI explanation'}).click();
    await inFlight;
    const response=page.waitForResponse('**/api/staff/explain');
    await page.getByLabel('Option ordering').selectOption('baseline');
    await page.getByLabel('Option ordering').selectOption('fit');
    pause.resolve();
    holdExplanation=undefined;
    await response;
    await expect(page.getByRole('heading',{name:'AI explanation'})).toHaveCount(0);
    await page.getByLabel('Option ordering').selectOption('baseline');
    await page.getByRole('button',{name:'Request AI explanation'}).click();
    await expect(page.getByRole('heading',{name:'AI explanation'})).toBeVisible();
    expect(explanationFilter).toBe('information');
    expect(explanationOrder).toBe('baseline');
    await page.setViewportSize({width:390,height:844});
    await noPageOverflow(page);
    await page.getByRole('region',{name:'Goal review'}).screenshot({path:test.info().outputPath('goal-status-390.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Manage goals'}).click();
    await editor.getByRole('combobox',{name:'Goal to edit'}).selectOption('');
    await editor.getByLabel('Short name').fill('Delivery readiness');
    await editor.getByLabel('Description').fill('Prioritize confirmed inspection and delivery slots.');
    await editor.getByRole('button',{name:'Save goal'}).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'AI explanation'})).toHaveCount(0);
    await expect(table.getByRole('columnheader',{name:/Goal fit/})).toHaveCount(0);
    await expect(page.getByLabel('Filter by goal fit')).toHaveCount(0);
    await expect(page.getByLabel('Option ordering')).toHaveCount(0);
    await page.getByRole('button',{name:'Evaluate goal'}).click();
    const lead=table.getByRole('row').nth(1);
    await expect(lead).toContainText('East gate training plaza');
    await lead.getByRole('button',{name:/Goal evidence for/}).click();
    await expect(lead).toContainText('The delivery goal prioritizes the confirmed inspection slot.');
    await page.getByLabel('Filter by goal fit').selectOption('strong');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(optionCount).toHaveText('1 of 7 options shown');
    await page.getByRole('combobox',{name:'Program goal',exact:true}).selectOption({label:'Low disruption'});
    await expect(page.getByRole('button',{name:'Evaluate goal'})).toBeEnabled();
    await expect(page.getByLabel('Filter by goal fit')).toHaveCount(0);
    await expect(page.getByLabel('Option ordering')).toHaveCount(0);
    clarify=true;
    await page.getByRole('button',{name:'Evaluate goal'}).click();
    await expect(page.getByRole('region',{name:'Goal review'})).toContainText('What disturbance is acceptable?');
    await expect(table.getByRole('columnheader',{name:/Goal fit/})).toHaveCount(0);
    await page.getByRole('button',{name:'Request AI explanation'}).click();
    await expect(page.getByRole('article',{name:'AI explanation'})).toContainText('Compare modeled coverage and lifecycle costs.');
    expect(explanationFilter).toBeUndefined();
    await page.getByRole('button',{name:'Clear goal'}).click();
    await expect(table.getByRole('columnheader',{name:/Goal fit/})).toHaveCount(0);
    await expect(page.getByRole('region',{name:'Goal review'})).toHaveCount(0);
    await expect(budget).toHaveValue('27000');
    expect(evaluations).toBe(3);
  } finally {await context.close();}
});
