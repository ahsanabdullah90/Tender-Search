import fs from 'fs';
import path from 'path';
import { db, initDatabase, DOSSIERS_DIR, backupNow, getAllTenders } from '../src/server/db.js';
import {
  generateCanonicalFilename,
  getPortalFileCode,
  inferDocType,
  reconcileDossiers
} from '../src/server/dossierStore.js';
import { slimPassedTenders } from '../src/server/db/repositories/tendersRepo.js';

async function main() {
  initDatabase();
  const isLive = process.argv.includes('--live');
  const isDryRun = !isLive;

  console.log('='.repeat(70));
  console.log(`Tender Tracker - Dossier Canonical Naming Migration (${isLive ? 'LIVE' : 'DRY RUN'})`);
  console.log('='.repeat(70));

  if (isLive) {
    console.log('[1/4] Creating database safety backup before migration...');
    const backup = await backupNow();
    console.log(`  -> Safety backup created: ${backup?.name || 'OK'}`);
  } else {
    console.log('[1/4] Dry run mode active. No files or database rows will be modified.');
  }

  // 1. Check Passed tenders to slim
  console.log('\n[2/4] Checking Passed tenders pending file slimming...');
  const passedTenders = db.prepare(`
    SELECT id, title, passed_at FROM tenders
    WHERE pipeline_status = 'Passed' AND slimmed_at IS NULL
  `).all() as { id: string; title: string; passed_at: string | null }[];

  console.log(`  -> Found ${passedTenders.length} Passed tenders pending slimming.`);
  for (const t of passedTenders.slice(0, 10)) {
    console.log(`     - [SLIM] ${t.id}: ${t.title.slice(0, 40)}... (Passed at: ${t.passed_at || 'unknown'})`);
  }
  if (passedTenders.length > 10) {
    console.log(`     ... and ${passedTenders.length - 10} more.`);
  }

  if (isLive && passedTenders.length > 0) {
    const slimResult = slimPassedTenders(passedTenders.map(t => t.id));
    console.log(`  -> Successfully slimmed ${slimResult.slimmedCount} Passed tenders.`);
  }

  // 2. Scan dossiers for legacy non-canonical filenames
  console.log('\n[3/4] Inspecting cached dossiers for non-canonical file naming...');
  const tendersWithDossiers = db.prepare(`
    SELECT id, portal_id, reference_no, title, cached_dossiers
    FROM tenders
    WHERE cached_dossiers IS NOT NULL AND cached_dossiers != '[]'
  `).all() as { id: string; portal_id: string; reference_no: string | null; title: string; cached_dossiers: string }[];

  let totalDossiersChecked = 0;
  let renamesPlanned = 0;

  for (const t of tendersWithDossiers) {
    let dossiers: any[] = [];
    try {
      dossiers = JSON.parse(t.cached_dossiers);
    } catch {
      continue;
    }

    let modified = false;
    const tenderDir = path.resolve(DOSSIERS_DIR, t.id);
    const portalCode = getPortalFileCode(t.portal_id);

    for (let idx = 0; idx < dossiers.length; idx++) {
      totalDossiersChecked++;
      const doc = dossiers[idx];
      const oldFilename = path.basename(decodeURIComponent(doc.localPath || ''));
      if (!oldFilename) continue;

      // Check if already canonical format: {PORTAL}__{REF}__{type}-{n}__{hash8}.{ext}
      const isCanonical = /^[A-Z0-9]+__[A-Za-z0-9_-]+__[a-z-]+-\d+__[0-9a-f]{8}\.[a-z0-9]+$/i.test(oldFilename);
      if (isCanonical) continue;

      const oldDiskPath = path.resolve(tenderDir, oldFilename);
      if (!fs.existsSync(oldDiskPath)) {
        continue;
      }

      const buffer = fs.readFileSync(oldDiskPath);
      const ext = path.extname(oldFilename) || '.pdf';
      const docType = doc.docType || inferDocType(doc.label || oldFilename);

      const { filename: newFilename, sha256 } = generateCanonicalFilename({
        portalCode,
        referenceNo: t.reference_no,
        title: t.title,
        tenderId: t.id,
        docType,
        index: idx + 1,
        buffer,
        extension: ext
      });

      if (oldFilename === newFilename) continue;

      renamesPlanned++;
      const newDiskPath = path.resolve(tenderDir, newFilename);
      const newWebUrl = `/api/dossiers/${encodeURIComponent(t.id)}/${encodeURIComponent(newFilename)}`;

      if (renamesPlanned <= 15) {
        console.log(`     - [RENAME] ${oldFilename} -> ${newFilename}`);
      }

      if (isLive) {
        try {
          fs.renameSync(oldDiskPath, newDiskPath);
          doc.localPath = newWebUrl;
          doc.originalName = doc.originalName || oldFilename;
          doc.docType = docType;
          doc.sha256 = sha256;
          modified = true;
        } catch (err: any) {
          console.warn(`       Failed to rename ${oldFilename}: ${err.message}`);
        }
      }
    }

    if (isLive && modified) {
      db.prepare('UPDATE tenders SET cached_dossiers = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
        JSON.stringify(dossiers),
        t.id
      );
    }
  }

  console.log(`  -> Checked ${totalDossiersChecked} documents across ${tendersWithDossiers.length} tenders.`);
  console.log(`  -> ${renamesPlanned} files require canonical renaming.`);

  // 3. Reconcile orphans and dead records
  console.log('\n[4/4] Running dossier storage reconciliation...');
  const recon = reconcileDossiers({ dryRun: isDryRun, graceMinutes: 0 });
  console.log(`  -> Orphan folders detected: ${recon.orphanFoldersCount}`);
  console.log(`  -> Dead file references cleared: ${recon.missingFilesRemovedFromTenders}`);
  console.log(`  -> Trash cleaned: ${(recon.trashCleanedBytes / (1024 * 1024)).toFixed(2)} MB`);

  console.log('\n' + '='.repeat(70));
  if (isDryRun) {
    console.log('DRY RUN COMPLETE: Run with `npx tsx scripts/migrate-dossier-names.ts --live` to execute.');
  } else {
    console.log('MIGRATION COMPLETE: All files and database records updated successfully.');
  }
  console.log('='.repeat(70));
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
