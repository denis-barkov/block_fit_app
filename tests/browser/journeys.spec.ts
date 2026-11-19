import { expect,test,type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const credentials=()=>{
  const path=process.env.BLOCKFIT_STORE;
  if(!path)throw new Error('Run make test-browser to initialize an isolated database.');
  return JSON.parse(readFileSync(join(path,'demo-accounts.json'),'utf8')) as {
    staff:{email:string;password:string};resident:{email:string;password:string};
  };
};
const passphrase='a synthetic resident test passphrase';
async function allowFallback(page:Page) {
  await page.route('https://tiles.openfreemap.org/**',route=>route.abort());
}
async function noPageOverflow(page:Page) {
  expect(await page.locator('html').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
}
test('public discovery keeps the map ahead of listings on smaller screens and supports fallback',async({page})=>{
  await allowFallback(page);
  await page.goto('/');
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
  await page.route('https://tiles.openfreemap.org/styles/liberty',route=>route.fulfill({json:{
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
  let dialog=page.getByRole('dialog',{name:'Confirm private request origin'});
  await dialog.getByLabel('Location label (optional)').fill('Demo pin');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{name:'Save location'}).press('Enter');
  dialog=page.getByRole('dialog',{name:'Request equipment nearby'});
  await expect(dialog.getByLabel('Equipment type')).toHaveValue('parallel');
  await dialog.getByLabel('Note (optional)').fill('Initial note');
  await dialog.getByRole('button',{name:'Review request'}).press('Enter');
  await expect(dialog.getByRole('heading',{name:'Review your request'})).toBeFocused();
  await dialog.getByRole('button',{name:'Record request'}).press('Enter');
  await expect(page.getByText('Request recorded.')).toBeVisible();
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
  await noPageOverflow(page);
  await page.getByRole('button',{name:'Sign out'}).click();
  await expect(page.getByRole('heading',{name:'Find outdoor fitness equipment.'})).toBeVisible();
});
test('staff can compare and download on desktop and manage inventory on mobile',async({page})=>{
  await page.route('https://tiles.openfreemap.org/styles/liberty',route=>route.fulfill({json:{
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
  await expect(map).toBeVisible();
  for(const width of [768,390]) {
    await page.setViewportSize({width,height:844});
    const form=await assumptions.boundingBox();
    expect((await map.boundingBox())!.y).toBeGreaterThan(form!.y+form!.height);
  }
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
  await page.getByRole('button',{name:'Compare sites'}).click();
  const combination=page.getByRole('row',{name:/Central courtyard A.*Central courtyard B/});
  await expect(combination).toContainText('Over budget');
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
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download brief'}).click();
  expect((await download).suggestedFilename()).toBe('blockfit-comparison.md');
  await page.setViewportSize({width:390,height:844});
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
