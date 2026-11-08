# Vendor drivers and auto driver mode (0.7)

Spoolfree's default is a driverless queue: `Add-Printer -IppURL` with the inbox *Microsoft IPP Class Driver*. That is
the right choice for most printers since about 2015. It is the wrong one for two kinds of printer:

- **Printers that cannot do driverless printing.** These are IPP 1.x only, or have no PWG raster, URF or PDF, for
  example the Brother HL-2250DN, HL-5350DN and MFC-7860DW.
- **Printers that are too slow with it.** The IPP Class Driver sends 600-dpi sRGB PWG raster. An older colour laser
  whose NIC or CPU cannot keep up takes minutes per job. For example, a 2012 Brother HL-3150CDN took about
  5 minutes for 6 pages, and was fast with its vendor driver.

For these printers, an agent can install a **signed vendor driver** and create the queue on a Standard TCP/IP port.

Vendor drivers put third-party driver code back on PCs. That is the code Windows Protected Print Mode and the
PrintNightmare hardening are meant to keep away. **Use them only for printers that need one.** Auto mode does exactly
that.

## Driver modes

Each printer has a **Driver** setting in the printer form, or `driverMode` in [bulk import](deployment.md#bulk-import-and-export):

| Mode | PCs get |
|---|---|
| `auto` (default) | Spoolfree decides, as described below. The printer form and the Drivers page show the decision and its reason. |
| `driverless` | Always the IPP Class Driver. |
| `vendor` | Always the chosen package (`driverPackage`) and driver (`driverName`). |

A vendor queue's port is set by **Vendor driver port** (`protocol`):

- `raw9100` (default): Standard TCP/IP, RAW, port 9100.
- `lpr`: Standard TCP/IP, LPR, with queue `lprQueue` (default `lp`). Brother calls its queue `BINARY_P1`.
- `ipp`: an IPP *Internet Port* to the printer's IPP address. It is created with `printui /if`. This is experimental;
  prefer RAW 9100.

### How auto mode decides

A printer in auto mode gets a vendor driver when any of these is true:

1. **No driverless format.** The last Test found no `image/pwg-raster`, `image/urf` or `application/pdf`.
2. **IPP 1.x only.** `ipp-versions-supported` has no 2.x.
3. **Measured as slow.** Every `DRIVER_AUTO_SPEED_INTERVAL_MINUTES` (default 30), the poller reads the printer's
   completed jobs (IPP `Get-Jobs`, `which-jobs=completed`, `time-at-processing`, `time-at-completed`,
   `job-impressions-completed`). A median above `DRIVER_AUTO_SLOW_SECONDS_PER_PAGE` (default 20 s/page) over at least
   `DRIVER_AUTO_SLOW_MIN_JOBS` jobs (default 3) counts as slow. Jobs with fewer than `DRIVER_AUTO_SLOW_MIN_PAGES`
   pages (default 2) are not measured, because warm-up time dominates them. Only jobs printed over IPP are visible
   this way. Printers that do not keep completed jobs are not measured.
4. **Static hint.** The printer is raster only (no PDF), has no raster compression (`compression-supported` is only
   `none`), is colour, and its PWG raster resolution is at most 600 dpi.

Otherwise the printer gets the driverless queue.

**Auto mode does not flap.** Once it decides that a printer needs a vendor driver, it stores the decision and its
reason (`printers.auto_vendor_reason`, plus an audit row `printer.driver_auto`). The decision stays until an admin
changes the printer's driver mode or replaces the device. To have auto mode decide again, use **Re-evaluate driver
(auto)** in the printer's menu.

Rules 1, 2 and 4 use the last **Test**. In 0.7, Test also reads `printer-device-id` and `compression-supported`.
Re-test old printers, from the UI or with `spoolfree-cli printers test`, so auto mode has these.

### Which package auto mode uses

When a printer resolves to vendor, the server picks a package:

1. **The exact model.** Spoolfree takes the printer's IEEE 1284 device ID (IPP `printer-device-id`: `MFG` and `MDL`)
   and matches it against the hardware IDs in each package's INF. These are IDs like
   `USBPRINT\BROTHERHL-3150CDN_SEED27` and `WSDPRINT\...`: MFG+MDL with the spaces removed, truncated, plus a 4-digit
   checksum. If no hardware ID matches, it compares the driver name with the printer's make and model. When several
   packages match, the newest upload wins.
2. **The brand's universal driver.** A package uploaded as **universal**, for example Brother Universal Printer or
   HP Universal Printing PCL 6, serves every printer of its manufacturer that no exact package covers. Spoolfree
   uses its *universal driver* name, which defaults to the INF's first model.

If no package matches, the printer **stays driverless**. The UI shows *"vendor driver needed: upload one for
&lt;model&gt;"* in the Printers list and at the top of the Drivers page. To see the decision for every printer:

```sh
kubectl exec -n <ns> deploy/spoolfree -c spoolfree -- node cli/spoolfree-cli.mjs drivers decide
```

## Driver packages

A package is a **zip of the driver's INF/CAT/files tree** for Windows x64: the INF, the catalog (`.cat`) it names, and
the files it copies, with relative paths kept. Do not upload installers (`setup.exe`).

### Where to get a package

Get it from the vendor's support site. A self-extracting `.exe` can be opened with 7-Zip without running it; take the
folder that holds the x64 INF.

Alternatively, use the **Microsoft Update Catalog** (catalog.update.microsoft.com). Search for the model and download
the `.cab`, then run `expand.exe -F:* <cab> <dir>` and zip the directory. Catalog drivers are WHQL-signed by Microsoft.

Before you upload, check the catalog's signature:

```powershell
Get-AuthenticodeSignature .\BROCH12A.CAT   # Status must be Valid
```

### Uploading a package

You can upload from the **Drivers** page (admin), or with the CLI. The CLI reads the zip from stdin:

```sh
kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- \
  node cli/spoolfree-cli.mjs drivers upload "Brother HL-3150CDN" - < brother-hl3150cdn-x64.zip
kubectl exec -i -n <ns> deploy/spoolfree -c spoolfree -- \
  node cli/spoolfree-cli.mjs drivers upload "Brother Universal (PCL)" - --universal < brother-universal-x64.zip
node cli/spoolfree-cli.mjs drivers list
node cli/spoolfree-cli.mjs drivers delete "Old package" --dry-run
```

The upload is refused unless:

- the zip is readable and contains no unsafe paths (absolute, drive letters, `..`) and no encrypted entries;
- at least one INF is printer class (`Class=Printer`) and has an **NTamd64** models section;
- that INF's `[Version]` names a `CatalogFile` (or `CatalogFile.NTamd64`), and that file is in the zip next to it.

The server records:

- the name, file name, size and SHA-256 of the zip;
- the architecture (x64);
- per INF: its path, catalog, `DriverVer`, provider, manufacturers, and every driver name (the
  `Add-PrinterDriver -Name` value) with its hardware IDs;
- for universal packages, the universal flag and driver;
- the uploader and the date.

Every upload and delete is written to the audit log.

A package that a printer uses in `vendor` mode cannot be deleted. Printers in auto mode match again at the next sync.
Drivers already installed on PCs stay installed.

### Storage

Packages are stored **in Postgres**: `driver_packages` holds one row per package, and `driver_package_chunks` holds
the zip bytes in 4 MiB rows. They are backed up with the database. They need no volume, PVC or StorageClass, they
work with any number of replicas, and the Helm chart is unchanged.

Uploads are streamed to a temporary file (`/tmp`, an emptyDir in the chart), hashed and inspected there, then copied
to Postgres. Downloads are streamed one chunk at a time, so memory use stays low for large packages.

The size limit is `DRIVER_PACKAGE_MAX_MB` (default 200). A typical printer package is 1-25 MB. Each package adds its
size to the database and to its backups.

An earlier design used a PVC. It was not chosen because the PVC would need a separate backup, a ReadWriteOnce volume
blocks rolling updates and more than one replica, and the CLI would have to write to the volume too.

## What the agent does (agents 0.7+)

For each printer whose manifest entry has `driverMode: "vendor"`, the agent:

1. **Downloads the package.** It fetches `/api/agent/drivers/<id>` with its machine token. The server serves only
   packages that this computer's own manifest names.
2. **Checks the bytes.** The SHA-256 and size must match the **signed manifest**. The package goes into a
   **SYSTEM-only** directory (`%ProgramData%\Spoolfree\DriverStaging\<random>`, protected ACL) and is removed
   afterwards.
3. **Extracts it.** Any entry that would leave that directory is refused.
4. **Checks the signature.** The INF must name the catalog, and `Get-AuthenticodeSignature` on the `.cat` must be
   **Valid**. `pnputil` then checks every file against the catalog, and x64 Windows refuses unsigned or modified
   files.
5. **Installs the driver** with `pnputil /add-driver <inf> /install` and `Add-PrinterDriver -Name <driverName>`. It
   records the package under `HKLM\SOFTWARE\Spoolfree\Drivers\<sha256>`, so later syncs skip the download.
6. **Creates the queue** on a Standard TCP/IP port (`SPOOLFREE_<host>` for RAW 9100, `SPOOLFREE_LPR_<host>_<queue>`
   for LPR) or an IPP Internet Port.

Everything else works as for driverless queues: the "Managed by Spoolfree" comment and marker, legacy takeover
(matching by IP, host name, aliases, MAC and printer-uuid), renames, default printer carry-over, the default duplex
and print analytics. The default duplex is applied with `Set-PrintConfiguration` where the driver supports it; a
driver that refuses it is noted in the log, not reported as an error.

**Switching mode** (driverless to vendor, vendor to driverless, or a new package, driver or port) uses
**make-before-break**:

1. The new queue is created next to the old one as `<name> (Spoolfree)`. This works because a TCP/IP queue can
   coexist with the device's IPP queue.
2. The old queue is removed.
3. The new queue is renamed to `<name>`.

If the vendor driver cannot be installed, the old queue stays and the error is reported. The next sync tries again.

If a new driverless queue cannot be created next to the old one, the agent falls back to remove-then-add, including
the usual IPP recovery and TCP/IP fallback.

On a **new** PC, a failed vendor install creates the driverless queue instead. The PC is never left without the
printer, and the next sync retries the vendor driver.

**Windows Protected Print Mode:** when WPP is enforced, vendor drivers are not allowed. The agent reports
*"vendor driver not allowed under WPP"* (Agents page) and uses the driverless queue.

The agent's report lists each queue with its driver and port (`queues`) and the vendor driver results (`drivers`:
`installed`, `present`, `wpp-blocked`, `failed`, `fallback`). On the Agents page, vendor queues show
"<queue>: <driver> on <port>".

## Settings

| Variable | Default | |
|---|---|---|
| `DRIVER_PACKAGE_MAX_MB` | `200` | Largest package accepted. |
| `DRIVER_AUTO_SLOW_SECONDS_PER_PAGE` | `20` | Auto mode: median seconds per page above this counts as slow. |
| `DRIVER_AUTO_SLOW_MIN_JOBS` | `3` | Jobs needed before speed counts. |
| `DRIVER_AUTO_SLOW_MIN_PAGES` | `2` | Jobs with fewer pages are not measured. |
| `DRIVER_AUTO_SPEED_INTERVAL_MINUTES` | `30` | How often the poller reads completed jobs; `0` turns speed measuring off. |

## Not done yet

**Automatic download from the Microsoft Update Catalog** is not built. The catalog has no API: it is an HTML search
page with per-session download links, and its packages are `.cab` files that need `expand.exe`. Scraping it from the
server would be brittle, and the download would bypass the admin's review of what goes onto PCs.

For now, the admin downloads the driver once (for example a brand's universal driver plus a few exact-model drivers)
and uploads it. A future version could search the catalog by the printer's hardware ID, offer the result on the
Drivers page for one-click review, and import it after checking the Microsoft signature.
