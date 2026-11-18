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
test('public discovery stays operable on desktop and tablet when the map cannot load',async({page})=>{
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
  for (const width of [1440,768,390]) {
    await page.setViewportSize({width,height:900});
    await noPageOverflow(page);
  }
});
test('map pin and list share selection with an offline vector style',async({page})=>{
  await page.route('https://tiles.openfreemap.org/styles/liberty',route=>route.fulfill({json:{
    version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#dbece2'}}],
  }}));
  await page.goto('/');
  const map=page.getByLabel('Public equipment map');
  const bench=map.getByRole('button',{name:'Standalone sit-up bench'});
  await expect(bench).toBeVisible();
  await bench.click();
  await expect(page.getByRole('article',{name:'Selected equipment'})).toContainText('Standalone sit-up bench');
  await expect(bench).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:/West court pull-up bars.*Verification recorded/}).click();
  await expect(map.getByRole('button',{name:'West court pull-up bars'})).toHaveAttribute('aria-pressed','true');
});
test('mobile registration preserves the selected category and persists the resident lifecycle',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await allowFallback(page);
  await page.goto('/');
  await page.getByLabel('Equipment type').selectOption('parallel');
  await expect(page.getByRole('article',{name:'Selected equipment'})).toContainText('East court parallel bars');
  await page.getByRole('button',{name:'Request this equipment nearby'}).click();
  let dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Forgot password?'}).click();
  await expect(dialog).toContainText('Never send your password.');
  await expect(dialog.getByRole('link',{name:'Contact us'})).toHaveAttribute('href','mailto:contact@blockfit.example');
  await dialog.getByRole('button',{name:'Back to sign in'}).click();
  await dialog.getByRole('button',{name:'Create resident account'}).click();
  await dialog.getByLabel('Display name').fill('Mobile test');
  await dialog.getByLabel('Email').fill('browser-resident@blockfit.example');
  await dialog.getByLabel('Password',{exact:true}).fill(passphrase);
  await dialog.getByLabel('Confirm password').fill(passphrase);
  await dialog.getByRole('button',{name:'Register'}).press('Enter');
  dialog=page.getByRole('dialog',{name:'Confirm private request origin'});
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
  await allowFallback(page);
  const {staff}=credentials();
  await page.goto('/city');
  await page.getByRole('button',{name:'Sign in'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(staff.email);
  await dialog.getByLabel('Password',{exact:true}).fill(staff.password);
  await dialog.getByRole('button',{name:'Sign in',exact:true}).press('Enter');
  await expect(page.getByRole('heading',{name:'Where could investment improve access?'})).toBeVisible();
  await page.getByRole('checkbox',{name:'Central courtyard A'}).check();
  await page.getByRole('checkbox',{name:'Central courtyard B'}).check();
  await page.getByRole('button',{name:'Compare sites'}).click();
  await expect(page.getByRole('row',{name:/Central courtyard A \+ Central courtyard B/})).toContainText('Over budget');
  await page.getByRole('button',{name:'Request AI explanation'}).click();
  await expect(page.getByRole('alert')).toContainText('AI is unavailable.');
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download brief'}).click();
  expect((await download).suggestedFilename()).toBe('blockfit-comparison.md');
  await page.setViewportSize({width:390,height:844});
  await noPageOverflow(page);
  await page.getByRole('button',{name:'Add equipment'}).click();
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
