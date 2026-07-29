#!/usr/bin/env node
'use strict';
// scripts/flatten-into-parts.js
//
// Merapikan struktur proyek: SEMUA file dari SEMUA subfolder dikeluarkan &
// dipindah rata (flatten) ke folder baru "part-001", "part-002", dst.
// - Maks 100 file per folder part-xxx.
// - Nama file TIDAK pernah diubah.
// - Kalau ada nama file yang sama (basename identik) dari folder asal
//   berbeda, file-file itu dipisah ke part-xxx yang BERBEDA (tidak pernah
//   ada 2 file bernama sama dalam 1 folder part-xxx yang sama).
// - Isi file TIDAK disentuh (pure `fs.renameSync`, bukan re-write).
// - IDEMPOTENT: aman dijalankan berkali-kali. Kalau dijalankan ulang setelah
//   proyek sudah rata di part-xxx/, script mendeteksi "sudah selesai" dan
//   tidak melakukan apa-apa (no-op) — tidak akan menimpa/menghilangkan file.
//
// Cara pakai:
//   node scripts/flatten-into-parts.js [root_dir]
// (default root_dir = cwd saat script dijalankan)

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const MAX_PER_FOLDER = 100;
const PART_PREFIX = 'part-';
const SELF_PATH = path.resolve(__filename);

function isPartFolderName(name) {
  return /^part-\d{3,}$/.test(name);
}

// Kumpulkan SEMUA file di ROOT secara rekursif, KECUALI:
// - file-file yang sudah berada langsung di dalam folder part-xxx level-1
//   di ROOT (supaya idempotent: run kedua tidak menganggap file yang sudah
//   dirapikan sebagai "file baru yang perlu dipindah lagi").
// - script ini sendiri (supaya tidak memindahkan dirinya sendiri saat
//   dijalankan dari dalam scripts/, yang notabene juga akan ikut ter-flatten
//   normal kalau bukan karena exclude ini; kita KECUALIKAN eksplisit karena
//   script perlu tetap ada di lokasi yang predictable untuk dijalankan ulang).
function collectSourceFiles(dir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Skip folder part-xxx yang sudah ada di level ROOT langsung (hasil
      // run sebelumnya) — file di dalamnya dianggap SUDAH beres, bukan
      // sumber yang perlu dipindah lagi.
      if (dir === ROOT && isPartFolderName(ent.name)) continue;
      collectSourceFiles(full, acc);
    } else if (ent.isFile()) {
      if (full === SELF_PATH) continue;
      acc.push(full);
    }
  }
  return acc;
}

function listExistingPartFolders() {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isPartFolderName(e.name))
    .map((e) => e.name)
    .sort();
}

function main() {
  const sourceFiles = collectSourceFiles(ROOT, []);

  if (sourceFiles.length === 0) {
    // IDEMPOTENCY: tidak ada file tersisa di luar part-xxx -> proyek sudah
    // rata sebelumnya, no-op total.
    const existing = listExistingPartFolders();
    console.log('Tidak ada file di luar folder part-xxx — sudah rata (no-op).');
    console.log(`Folder part-xxx yang sudah ada: ${existing.length} (${existing.join(', ') || '-'})`);
    return;
  }

  // Muat state folder part-xxx yang SUDAH ADA (kalau script pernah dipanggil
  // sebagian / terputus di tengah jalan) supaya run berikutnya melanjutkan
  // dari situ, bukan mulai dari part-001 lagi & menimpa.
  const existingPartNames = listExistingPartFolders();
  // folderState: nama folder -> { count, basenames: Set }
  const folderState = new Map();
  for (const name of existingPartNames) {
    const full = path.join(ROOT, name);
    const files = fs.readdirSync(full, { withFileTypes: true }).filter((e) => e.isFile());
    folderState.set(name, {
      count: files.length,
      basenames: new Set(files.map((f) => f.name)),
    });
  }

  let nextPartNumber = existingPartNames.length
    ? Math.max(...existingPartNames.map((n) => parseInt(n.slice(PART_PREFIX.length), 10))) + 1
    : 1;

  function ensureFolder(name) {
    const full = path.join(ROOT, name);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
    if (!folderState.has(name)) folderState.set(name, { count: 0, basenames: new Set() });
    return full;
  }

  function newPartName() {
    const name = PART_PREFIX + String(nextPartNumber).padStart(3, '0');
    nextPartNumber += 1;
    return name;
  }

  // Urutkan source files deterministik (path lengkap) supaya hasil run
  // reproducible.
  sourceFiles.sort();

  // Cari folder part-xxx TERBUKA (belum penuh) yang bisa dipakai untuk
  // basename tertentu — folder existing (dari run sebelumnya, urut nama)
  // DULU, baru bikin folder baru kalau semuanya penuh/konflik nama.
  function findOrCreateTargetFolder(basename) {
    const sortedNames = Array.from(folderState.keys()).sort();
    for (const name of sortedNames) {
      const st = folderState.get(name);
      if (st.count < MAX_PER_FOLDER && !st.basenames.has(basename)) {
        return name;
      }
    }
    const name = newPartName();
    ensureFolder(name);
    return name;
  }

  const moved = [];
  const duplicateGroups = new Map(); // basename -> [{from, toFolder}]

  for (const src of sourceFiles) {
    const basename = path.basename(src);
    const targetFolder = findOrCreateTargetFolder(basename);
    const targetFull = path.join(ROOT, targetFolder);
    ensureFolder(targetFolder);
    const dest = path.join(targetFull, basename);

    // Guard idempotency/tabrakan tak terduga: kalau entah bagaimana dest
    // sudah ada (seharusnya tidak mungkin krn findOrCreateTargetFolder sudah
    // cek basenames), JANGAN timpa — lempar error supaya kelihatan, bukan
    // diam-diam kehilangan file.
    if (fs.existsSync(dest)) {
      throw new Error(`Tabrakan tak terduga: ${dest} sudah ada, membatalkan pemindahan ${src}`);
    }

    fs.renameSync(src, dest);

    const st = folderState.get(targetFolder);
    st.count += 1;
    st.basenames.add(basename);

    moved.push({ from: path.relative(ROOT, src), to: `${targetFolder}/${basename}` });
    if (!duplicateGroups.has(basename)) duplicateGroups.set(basename, []);
    duplicateGroups.get(basename).push(`${targetFolder}/${basename}`);
  }

  // Bersihkan folder-folder sumber yang jadi kosong (rapi-rapi, TIDAK
  // menyentuh isi/nama file apa pun — cuma direktori kosong).
  removeEmptyDirsExceptRoot(ROOT);

  // ---- Ringkasan ----
  const allPartFolders = listExistingPartFolders();
  const totalFilesNow = allPartFolders.reduce((sum, name) => {
    return sum + fs.readdirSync(path.join(ROOT, name)).length;
  }, 0);

  console.log(`Total file dipindahkan run ini : ${moved.length}`);
  console.log(`Total file di seluruh part-xxx : ${totalFilesNow}`);
  console.log(`Total folder part-xxx          : ${allPartFolders.length} (${allPartFolders.join(', ')})`);

  console.log('\nNama file duplikat (basename sama, ditempatkan di folder part-xxx berbeda):');
  let anyDup = false;
  for (const [basename, locations] of duplicateGroups.entries()) {
    if (locations.length > 1) {
      anyDup = true;
      console.log(`  - ${basename}:`);
      for (const loc of locations) console.log(`      -> ${loc}`);
    }
  }
  if (!anyDup) console.log('  (tidak ada duplikat pada run ini)');
}

function removeEmptyDirsExceptRoot(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const full = path.join(dir, ent.name);
      if (dir === ROOT && isPartFolderName(ent.name)) continue; // jangan sentuh part-xxx
      removeEmptyDirsExceptRoot(full);
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    }
  }
}

main();
