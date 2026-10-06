# Sync Retail — Setting up a till PC for kiosk mode

**For:** the person who sets up the shop's PCs (owner, IT helper or installer).
**Time:** about 20–30 minutes per PC.

Sync Retail's kiosk mode stops **accidents**: closing the window, minimising it, reloading, zooming and right-clicking. Windows itself can still be reached with Ctrl+Alt+Del. To stop someone **deliberately** getting to the desktop, also lock down Windows using the steps below.

---

## 1. In Sync Retail

Kiosk mode is **off** on a new PC. Turn it on per till in **Admin → Kiosk** (it can only take effect once the PC's first setup, as Main Register or a paired register, is finished):

| Setting | Recommended |
|---|---|
| Kiosk mode on this register | On for tills, off for a back-office PC |
| Level | **Standard** for most shops. **Strict** adds always-on-top, blocks the Windows key and Alt+Tab while the till is in front, and relaunches the app if it is ended from Task Manager. |
| Start Sync Retail when Windows signs in | On |
| Customer display | "Second monitor, if connected" |
| Offline exit PIN (store-wide) | Set one: it's the only way to unlock a register while the Main Register is switched off |

In **Admin → Store & loyalty**, *Lock idle registers after* (default 5 minutes) sends an unattended register back to the PIN screen. The open sale is kept and is waiting after the next sign-in.

**Unlocking for maintenance:** press and hold the **Sr** logo (or the "Register … · locked" line on the lock screen) for 3 seconds, then enter a manager or admin PIN. The till becomes a normal window for 10 minutes, with **Restore kiosk now** and **Exit app** buttons. Every attempt is in the audit log.

**Support escape hatch:** starting the app with the environment variable `SR_KIOSK=0` turns kiosk off for that launch only.

---

## 2. Windows: a dedicated till account

Do this on every till. It is what makes kiosk mode hard to escape.

1. **Create a standard (non-admin) local account** called `Till`:
   *Settings → Accounts → Other users → Add account → I don't have this person's sign-in information → Add a user without a Microsoft account.*
   Keep your own administrator account for maintenance.
2. **Sign in once as Till**, then start Sync Retail. On a register, pair it in that account. It turns on "start when Windows signs in" for that account.
3. **Automatic sign-in:** use Microsoft's free **Sysinternals Autologon** (stores the password encrypted). Run it as administrator, enter the Till account and its password, then click *Enable*.
4. **Windows Update:** set *active hours* to cover trading hours, so restarts happen overnight.
5. **Notifications:** turn on *Do not disturb* in the Till account.

## 3. Windows Pro: policy hardening (optional, recommended for Strict)

Run `scripts/windows/kiosk-setup.ps1` **as administrator** and give it the till account name:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\kiosk-setup.ps1 -TillUser Till
```

For the till account, it:

- removes **Task Manager, Lock and Change password** from the Ctrl+Alt+Del screen
- disables **Windows-key shortcuts** (`NoWinKeys`)

It also hides **Switch user** for the whole PC (Windows only offers this setting machine-wide). To do maintenance, press Ctrl+Alt+Del → **Sign out** and sign in with your administrator account.

The script refuses to run against an administrator account. Undo everything with `-Undo`. Your administrator account's own settings are never changed.

## 4. Windows Enterprise / Education / IoT Enterprise: Shell Launcher

This is the strongest option: Sync Retail **replaces the desktop** for the Till account. There is no taskbar or Start menu, and Windows restarts the app if it ever closes.

1. *Turn Windows features on or off → Device Lockdown → Shell Launcher* (needs a restart).
2. In an administrator PowerShell, set Sync Retail as the Till account's shell (Windows' own *Shell Launcher v2* steps, using `C:\Program Files\Sync Retail\sync-retail.exe`, with *restart the shell* as the exit action).
3. Leave the administrator account on the normal Explorer shell.

With Shell Launcher, use **Standard** kiosk level: Windows already does what Strict adds.

---

## 5. Check before handing over

| Check | Expected |
|---|---|
| Restart the PC | Signs in as Till and opens Sync Retail full screen within about 20 s |
| ✕ / Alt+F4 / Esc / F11 | Nothing happens (a toast says to ask a manager) |
| F5, Ctrl+R, Ctrl+P, Ctrl+wheel, right-click | Nothing happens |
| Win+↓ | The till goes straight back to full screen |
| Strict: Windows key, Alt+Tab | Nothing happens |
| Strict: end the app in Task Manager | It comes back within about 5 s |
| Hold the Sr logo 3 s → manager PIN | Windowed for 10 minutes, then back to kiosk |
| Switch off the Main Register → hold the logo on a register → offline exit PIN | Unlocks; reported to the audit log after reconnecting |
| Leave the till untouched for the idle time | Warning 30 s before; then the PIN screen, with the sale kept |
| Second monitor connected | Customer display opens there, full screen |

**Ctrl+Alt+Del always works.** That is by Windows' design, and it's your way back in if anything goes wrong.
