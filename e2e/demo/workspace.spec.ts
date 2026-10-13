import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const preview = (page: Page) => page.frameLocator('iframe[title="Artifact preview"]');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
async function fork(page: Page, id: string, title: string) {
  await page.goto(`./#/project/${id}`);
  await page.getByRole('button', { name:'Fork', exact:true }).click();
  const dialog = page.getByRole('dialog', { name:'Fork artifact', exact:true });
  await dialog.getByLabel('Title', { exact:true }).fill(title);
  await dialog.getByRole('button', { name:'Fork artifact', exact:true }).click();
  await expect(page).toHaveURL(/project\/local-/);
  await expect(page.getByLabel('New file path')).toBeEnabled();
}
async function replaceSource(page: Page, text: string) {
  const editor = page.getByLabel('Source code', {exact:true});
  await editor.click(); await page.keyboard.press(`${mod}+A`); await page.keyboard.insertText(text);
}
async function save(page: Page, message: string) {
  const showCode = page.getByRole('button', {name:'Show code',exact:true});
  if (await showCode.isVisible()) await showCode.click();
  await page.getByLabel('What changed?', { exact:true }).fill(message);
  await page.getByRole('button', { name:'Save version', exact:true }).click();
  await expect(page.getByRole('button', { name:'Save version', exact:true })).toBeDisabled();
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  // The production static build must work without an API or third-party scripts.
  await page.route('**/api/**', route => { throw new Error(`Unexpected backend request: ${route.request().url()}`); });
});

test('catalog, real worker and Python runs, nested libraries, and isolated model code', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading',{name:/Artifacts/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toHaveCount(0);
  await page.getByRole('searchbox').fill('Random walks');
  await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Random walks',exact:true})}).click();
  await expect(preview(page).getByRole('status')).toHaveText('Ready');
  await preview(page).getByRole('button',{name:'Run',exact:true}).click();
  await expect(preview(page).getByRole('status')).toContainText('Mean squared displacement:');
  const modelFrame = page.frames().find(f => f.url().startsWith('blob:'))!;
  expect(await modelFrame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } })).toBe(true);
  expect(await modelFrame.evaluate(() => { try { void indexedDB.open('probe'); return false; } catch { return true; } })).toBe(true);
  await page.goto('./#/project/python');
  await expect(preview(page).getByRole('status')).toContainText('Python ready');
  await preview(page).getByRole('button',{name:'Run',exact:true}).click();
  await expect(preview(page).getByRole('status')).toContainText('Total heat: 2000.000');
  await page.goto('./#/project/python-pulse');
  await expect(preview(page).getByRole('status')).toHaveText('Python ready');
  await preview(page).getByRole('button',{name:'Run',exact:true}).click();
  await expect(preview(page).getByRole('status')).toHaveText('Peak: 60.000 · Contrast: 60.000 · Total: 100.000');
  await page.goto('./#/project/grid-walkers');
  await expect(preview(page).locator('canvas')).toBeVisible();
  await expect(page.getByRole('link',{name:'Agent grid',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/demo-model.png'});
});

test('fork, live edit, persist draft, save history, compare, restore and export/import', async ({ page, browser }) => {
  await fork(page,'commons','Local garden');
  const url = page.url();
  await page.getByRole('treeitem',{name:'index.html',exact:false}).click();
  await replaceSource(page,'<!doctype html><h1>My local experiment</h1><script type="module">document.body.dataset.ran="yes";</script>');
  await expect(preview(page).getByRole('heading',{name:'My local experiment'})).toBeVisible();
  await expect(page.getByLabel('Save status')).toHaveText('Draft saved');
  await page.reload();
  await expect(preview(page).getByRole('heading',{name:'My local experiment'})).toBeVisible();
  await save(page,'Change the experiment');
  await page.getByRole('button',{name:'History',exact:true}).click();
  await expect(page.getByText('Change the experiment',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Compare Change the experiment',exact:true}).click();
  await page.getByRole('textbox',{name:'Commit diff'}).click();
  await page.getByRole('textbox',{name:'Commit diff'}).press(`${mod}+End`);
  await expect(page.getByRole('textbox',{name:'Commit diff'})).toContainText('My local experiment');
  await page.locator('.history-select').filter({hasText:'Copy The commons garden'}).click();
  await page.getByRole('button',{name:'Restore this version',exact:true}).click();
  await page.getByRole('button',{name:'Restore version',exact:true}).click();
  await expect(preview(page).getByRole('heading',{name:'The commons garden'})).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export workspace'}).click();
  const download = await downloaded; const path = await download.path();
  expect(path).toBeTruthy();
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto(url);
  await expect(second.getByRole('alert')).toContainText('Project not found');
  await second.getByLabel('Import demo workspace').setInputFiles(path!);
  await expect(second.locator('.crumb')).toContainText('Local garden');
  await expect(preview(second).getByRole('heading',{name:'The commons garden'})).toBeVisible();
  await other.close();
  await page.getByRole('button',{name:'Reset demo'}).click();
  await page.getByRole('link',{name:'My artifacts',exact:true}).click();
  await expect(page.getByText('No artifacts yet.',{exact:true})).toBeVisible();
});

test('create a model and install a library in its draft', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button',{name:'New artifact'}).click();
  const dialog = page.getByRole('dialog',{name:'New artifact',exact:true});
  await dialog.getByLabel('Template',{exact:true}).selectOption('worker');
  await dialog.getByLabel('Title',{exact:true}).fill('New browser experiment');
  await dialog.getByRole('button',{name:'Create artifact',exact:true}).click();
  await expect(preview(page).getByRole('status')).toHaveText('Ready');
  await page.getByRole('button',{name:'Add library',exact:true}).click();
  const install = page.getByRole('dialog');
  await expect(install).toBeVisible();
  await install.getByRole('combobox',{name:'Library',exact:true}).selectOption('browser-kit');
  await install.getByText('Files and version details', {exact:true}).click();
  await expect(install.getByLabel('index.js',{exact:true})).toBeVisible();
  await install.getByLabel('index.js',{exact:true}).check();
  await install.getByRole('button',{name:'Add to artifact',exact:true}).click();
  await expect(page.getByRole('link',{name:'Browser kit',exact:true})).toBeVisible();
  await save(page,'Install browser helpers');
  await page.reload();
  await expect(page.getByRole('link',{name:'Browser kit',exact:true})).toBeVisible();
});

test('NetLogo runs, persists interface edits, and exports portable models', async ({ page, context }) => {
  await fork(page,'netlogo','Local NetLogo');
  await expect(page.getByRole('button',{name:'Edit interface',exact:true})).toBeEnabled();
  await preview(page).locator('.netlogo-button').filter({hasText:/^\s*setup\s*$/}).click();
  await expect(preview(page).locator('.netlogo-monitor').filter({hasText:'walkers'})).toContainText('40');
  await page.getByRole('button',{name:'Edit interface',exact:true}).click();
  const widgetId = await preview(page).locator('.netlogo-slider').filter({hasText:'population'}).getAttribute('id');
  const overlay = preview(page).getByRole('button',{name:`Editable overlay for widget ${widgetId!.match(/(\d+)$/)![1]} of type slider`,exact:true});
  await overlay.focus(); await overlay.press('Enter');
  const properties = preview(page).locator('.widget-edit-form');
  await properties.getByLabel('Default value:',{exact:true}).fill('73');
  await properties.getByRole('button',{name:'OK',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Interface saved to draft'})).toBeVisible();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await save(page,'Change population to 73');
  await page.reload();
  await expect(preview(page).locator('.netlogo-slider').filter({hasText:'population'}).locator('input[type="number"]')).toHaveValue('73');
  await preview(page).locator('.netlogo-button').filter({hasText:/^\s*setup\s*$/}).click();
  await expect(preview(page).locator('.netlogo-monitor').filter({hasText:'walkers'})).toContainText('73');
  await page.screenshot({path:'test-results/demo-netlogo.png'});
  const nativeDownload = page.waitForEvent('download');
  await preview(page).locator('[aria-label="Export Options"]').getByRole('button',{name:'NetLogo',exact:true}).click();
  const native = readFileSync((await (await nativeDownload).path())!, 'utf8');
  expect(native).toContain('<model version="NetLogo');
  expect(native).toContain('73');
  const htmlDownload = page.waitForEvent('download');
  await preview(page).locator('[aria-label="Export Options"]').getByRole('button',{name:'HTML',exact:true}).click();
  const exportDirectory = mkdtempSync(resolve(tmpdir(),'lab-demo-export-'));
  const htmlPath = resolve(exportDirectory,'model.html');
  await (await htmlDownload).saveAs(htmlPath);
  expect(readFileSync(htmlPath,'utf8')).not.toContain('installNetLogoBridge');
  const standalone = await context.newPage();
  await standalone.goto(pathToFileURL(htmlPath).href);
  await standalone.locator('.netlogo-button').filter({hasText:/^\s*setup\s*$/}).click();
  await expect(standalone.locator('.netlogo-monitor').filter({hasText:'walkers'})).toContainText('73');
  await standalone.close();
  rmSync(exportDirectory,{recursive:true,force:true});
});

test('editing Python source changes real simulation output and persists', async ({ page }) => {
  await fork(page,'python','Python experiment');
  await page.getByRole('treeitem',{name:'model.py',exact:false}).click();
  await replaceSource(page,'def simulate(steps, diffusivity):\n    return [21.0, 21.0]\n');
  await expect(page.getByLabel('Save status')).toHaveText('Draft saved');
  await save(page,'Change the Python experiment');
  await page.reload();
  await expect(preview(page).getByRole('status')).toContainText('Python ready');
  await preview(page).getByRole('button',{name:'Run',exact:true}).click();
  await expect(preview(page).getByRole('status')).toHaveText('Peak temperature: 21.000 · Total heat: 42.000');
  await page.getByRole('button',{name:'Console',exact:true}).click();
  await expect(page.getByLabel('Artifact console')).toContainText('Python interpreter ready');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.locator('iframe[title="Artifact preview"]')).toHaveCount(0);
});
