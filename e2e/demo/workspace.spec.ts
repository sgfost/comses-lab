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
  if (!(await page.locator('.code-console').isVisible())) {
    const files = page.getByRole('button', { name: 'Files', exact: true });
    if (await files.getAttribute('aria-expanded') !== 'true') await files.click();
    await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  }
  await page.getByLabel('What changed?', { exact:true }).fill(message);
  await page.getByRole('button', { name:'Save version', exact:true }).click();
  await expect(page.getByRole('button', { name:'Save version', exact:true })).toBeDisabled();
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  // The production static build must work without an API or third-party scripts.
  await page.route('**/api/**', route => { throw new Error(`Unexpected backend request: ${route.request().url()}`); });
});

test('showcase catalog, Python workers, physics controls, and isolated model code', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.model-row')).toHaveCount(5);
  await page.getByRole('searchbox').fill('Galaxy encounter');
  await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Galaxy encounter',exact:true})}).click();
  await expect(preview(page).getByRole('status')).toContainText('Running');
  const modelFrame = page.frames().find(f => f.url().startsWith('blob:'))!;
  expect(await modelFrame.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } })).toBe(true);
  expect(await modelFrame.evaluate(() => { try { void indexedDB.open('probe'); return false; } catch { return true; } })).toBe(true);
  for (const id of ['ant-trails', 'predator-prey', 'wave-tank']) {
    await page.goto(`./#/project/${id}`);
    await expect(preview(page).getByRole('button', {name:'Pause',exact:true})).toBeEnabled({timeout:45000});
    await preview(page).getByRole('button', {name:'Pause',exact:true}).click();
    await expect(preview(page).getByRole('status')).toContainText('Paused');
    await preview(page).getByRole('button', {name:'Step',exact:true}).click();
    await expect(preview(page).locator('#world')).toBeVisible();
  }
  await page.goto('./#/project/agent-grid');
  await expect(page.getByRole('link',{name:'Browser kit',exact:true})).toBeVisible();
});

test('fork, live edit, persist draft, save history, compare, restore and export/import', async ({ page, browser }) => {
  await fork(page,'galaxy-encounter','Local galaxy');
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
  await page.locator('.history-select').filter({hasText:'Copy Galaxy encounter'}).click();
  await page.getByRole('button',{name:'Restore this version',exact:true}).click();
  await page.getByRole('button',{name:'Restore version',exact:true}).click();
  await expect(preview(page).getByRole('heading',{name:'Galaxy encounter'})).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export workspace'}).click();
  const download = await downloaded; const path = await download.path();
  expect(path).toBeTruthy();
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto(url);
  await expect(second.getByRole('alert')).toContainText('Project not found');
  await second.getByLabel('Import demo workspace').setInputFiles(path!);
  await expect(second.locator('.crumb')).toContainText('Local galaxy');
  await expect(preview(second).getByRole('heading',{name:'Galaxy encounter'})).toBeVisible();
  await other.close();
  await page.getByRole('button',{name:'Reset demo'}).click();
  await page.getByRole('link',{name:'My artifacts',exact:true}).click();
  await expect(page.getByText('No artifacts yet.',{exact:true})).toBeVisible();
});

test('create a model and install a library in its draft', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button',{name:'New artifact'}).click();
  const dialog = page.getByRole('dialog',{name:'New artifact',exact:true});
  await dialog.getByLabel('Template',{exact:true}).selectOption('galaxy-encounter');
  await dialog.getByLabel('Title',{exact:true}).fill('New browser experiment');
  await dialog.getByRole('button',{name:'Create artifact',exact:true}).click();
  await expect(preview(page).getByRole('status')).toContainText('Running');
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
  await fork(page,'ant-trails','Python experiment');
  await page.getByRole('treeitem',{name:'model.py',exact:false}).click();
  await replaceSource(page, 'def command(data):\n    return dict(width=1, height=1, tick=0, delivered=777, agents=0, nest=[0.5,0.5], trail=[0], food=[0], ants=[])\n');
  await expect(page.getByLabel('Save status')).toHaveText('Draft saved');
  await save(page,'Change the Python experiment');
  await page.reload();
  await expect(preview(page).locator('#delivered')).toHaveText('777', {timeout:45000});
  await page.getByRole('button',{name:'Console',exact:true}).click();
  await expect(page.getByLabel('Artifact console')).toContainText('Python interpreter ready');
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.locator('iframe[title="Artifact preview"]')).toHaveCount(0);
});

test('file tree opens nested files by keyboard and stays in sync with CodeMirror', async ({ page }) => {
  await fork(page, 'galaxy-encounter', 'Tree navigation');
  await page.getByLabel('New file path').fill('notes/experiment.md');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Source files' });
  const folder = tree.getByRole('treeitem', { name: 'notes', exact: true });
  const file = tree.getByRole('treeitem', { name: 'experiment.md', exact: true });
  await expect(file).toHaveAttribute('aria-selected', 'true');
  await replaceSource(page, '# Experiment notes');
  await expect(page.getByLabel('Save status')).toHaveText('Draft saved');
  await folder.click();
  await expect(file).toHaveCount(0);
  await folder.press('ArrowRight');
  await expect(file).toBeVisible();
  await page.getByRole('button', { name: 'Close code view', exact: true }).click();
  await folder.focus();
  await folder.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(file).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Source code', { exact: true })).toContainText('Experiment notes');
  await page.getByRole('button', { name: 'Close code view', exact: true }).click();
  await file.click();
  await expect(page.getByLabel('Source code', { exact: true })).toBeVisible();
  await page.getByLabel('New file path').fill('notes/second.md');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(tree.getByRole('treeitem', { name: 'second.md', exact: true })).toBeVisible();
  await file.click();
  await expect(page.getByLabel('Source code', { exact: true })).toContainText('Experiment notes');
  await page.screenshot({ path: 'test-results/pierre-tree.png' });
});
