//! Strict kiosk only: a low-level keyboard hook that swallows Win, Alt+Tab,
//! Alt+Esc and Ctrl+Esc while Sync Retail is in the foreground. It never
//! records keys; it only drops that fixed set of combinations. Windows' secure
//! keys (Ctrl+Alt+Del) can't be blocked by any app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

use windows_sys::Win32::Foundation::{CloseHandle, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_LWIN, VK_RWIN, VK_TAB};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, SetWindowsHookExW, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, MSG,
    WH_KEYBOARD_LL,
};

static ACTIVE: AtomicBool = AtomicBool::new(false);
static INSTALL: Once = Once::new();

/// Turns blocking on or off. The hook thread is installed on first use.
pub fn set_active(on: bool) {
    ACTIVE.store(on, Ordering::SeqCst);
    if on {
        INSTALL.call_once(|| {
            std::thread::spawn(|| unsafe {
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), GetModuleHandleW(std::ptr::null()), 0);
                if hook.is_null() {
                    return;
                }
                // A low-level hook needs a message loop on its thread.
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            });
        });
    }
}

unsafe fn foreground_is_ours() -> bool {
    let hwnd = GetForegroundWindow();
    if hwnd.is_null() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    pid == GetCurrentProcessId()
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && ACTIVE.load(Ordering::Relaxed) && foreground_is_ours() {
        let k = &*(lparam as *const KBDLLHOOKSTRUCT);
        let vk = k.vkCode as u16;
        let alt = k.flags & LLKHF_ALTDOWN != 0;
        let ctrl = (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0;
        let block = vk == VK_LWIN || vk == VK_RWIN || (vk == VK_TAB && alt) || (vk == VK_ESCAPE && (alt || ctrl));
        if block {
            return 1;
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// Watchdog helper: blocks until the given process exits.
pub fn wait_for_process(pid: u32) {
    unsafe {
        let h = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if h.is_null() {
            return;
        }
        WaitForSingleObject(h, INFINITE);
        CloseHandle(h);
    }
}
