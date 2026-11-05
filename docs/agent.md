# Windows agent

The agent is a set of Windows PowerShell 5.1 scripts in [`agent/`](../agent). A GPO startup script installs it; a SYSTEM scheduled task then syncs at startup and hourly. See [deployment.md](deployment.md#4-gpo-setup-agent) for the rollout.

## How the agent creates queues

| Windows | Method | Notes |
|---|---|---|
| Windows 11 (all), Windows 10 builds whose `Add-Printer` has `-IppURL` | `Add-Printer -IppURL http(s)://printer:631/ipp/print` | **Primary.** Windows picks the Microsoft IPP Class Driver from the printer's IPP attributes. Creates a local, machine-wide queue. The only method reported to keep working with **Windows Protected Print Mode** on. The printer must be reachable when the queue is created; the agent retries at the next sync. |
| Older Windows 10 without `-IppURL`, WPP off | `Add-PrinterPort` (Standard TCP/IP) + `Add-Printer -DriverName "Microsoft IPP Class Driver"` | **Fallback.** Not WPP-compatible. Whether the class driver's output prints correctly over a raw TCP port depends on the printer model, so test it first. |
| No `-IppURL` and WPP on | none | Reported as an error. |

The agent checks whether `-IppURL` is available at runtime: `(Get-Command Add-Printer).Parameters.ContainsKey('IppURL')`.

## Which queues it touches

It only changes queues it created. Each one is recorded under `HKLM:\SOFTWARE\Spoolfree\Printers` and carries a `Managed by Spoolfree [...]` comment.

- A queue with the same name that someone else created is reported as a conflict and left alone.
- A queue whose comment was changed is not deleted.

## Default printer

Windows keeps the default printer per user. The agent records the policy default, and the *Spoolfree User Default* logon task applies it. That task only acts when the policy value changes, so a user's own choice is kept until then.

## Real-device findings

`Add-Printer -IppURL` has been tested as SYSTEM on one Windows 11 25H2 PC (build 26200, WPP off) against an AirPrint printer over plain IPP:

- The queue gets the Microsoft IPP Class Driver and a port named `WSD-<guid>` (description "IPP Port"), which Windows removes together with the queue.
- Windows allows only one IPP queue per device, so the agent removes a renamed queue before it adds the new one.
- Still untested: Windows 10 22H2, WPP on, and IPPS queues (including whether they need the "same security settings for all users" option).
- On laptops in Modern Standby, Task Scheduler holds the sync task as "Queued" until the device wakes, so changes are applied at the next wake rather than on the hour.
