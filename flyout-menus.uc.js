// Flyout Menus
// Rolls right-click menus out the way Windows 11 (WinUI) flyouts do: the top
// edge stays put, the menu grows downward, and the contents slide down with its
// bottom edge. Menus Firefox flips upward (not enough room below the cursor)
// roll the other way. 250ms, cubic-bezier(0, 0, 0, 1), measured frame by frame
// from the Edge context menu.
//
// How it works. Firefox only renders a menu at its window's current size, so
// growing its window frame by frame leaves an empty strip whenever Windows shows
// the bigger window before Firefox has drawn it. Instead, through js-ctypes:
//   1. popupshowing: the menu's window already exists but is hidden. It is
//      cloaked (DWMWA_CLOAK). On a cold open, when the window is not known yet,
//      every hidden popup window is cloaked and the others released once the
//      right one is found.
//   2. Wait until Firefox has shown, sized and painted the real menu.
//   3. A stand-in window with the same Mica backdrop shows a live DWM thumbnail
//      of the real menu (what taskbar previews use). Windows draws the copy, so
//      Firefox renders nothing during the roll. The stand-in grows each frame
//      and shows the matching slice of the menu.
//   4. The stand-in stays up while the menu is open, following the real menu's
//      size. The real menu stays cloaked underneath and receives all input, as
//      the stand-in is click-through. Handing back to the real menu is avoided
//      because re-enabling its backdrop flashes flat grey while Windows rebuilds
//      the blur.
//   5. When the menu closes, the stand-in is removed and the real menu restored
//      once Firefox has hidden it.
//
// Author: Devin Green (Artistro08)
// Docs:   https://learn.microsoft.com/windows/win32/dwm/thumbnail-ovw
(function () {
    // Settings
    let duration = 250;

    // Windows only; anything else keeps stock menus
    if (Services.appinfo.OS !== "WINNT") {
        return;
    }

    // Win32 Bindings
    // Declared up front so a missing API disables the mod instead of breaking menus.
    let win32;
    try {
        win32 = loadWin32();
    } catch (error) {
        console.warn("[Flyout Menus] Win32 setup failed, menus stay stock:", error);
        return;
    }

    let {
        ctypes, HWND, RECT, POINT, MARGINS, WNDCLASSEX, THUMBNAIL,
        FindWindowExW, GetCursorPos, GetWindow, GetWindowRect, IsWindow, IsWindowVisible,
        SetWindowPos, RegisterClassExW, CreateWindowExW, SetLayeredWindowAttributes,
        SendMessageW, DestroyWindow, GetModuleHandleW, GetProcAddress,
        DwmSetWindowAttribute, DwmGetWindowAttribute, DwmExtendFrameIntoClientArea,
        DwmRegisterThumbnail, DwmUpdateThumbnailProperties, DwmUnregisterThumbnail,
    } = win32;

    // Win32 Constants
    let GW_OWNER                        = 4;
    let WM_NCACTIVATE                   = 0x0086;
    let WS_POPUP                        = 0x80000000;
    let WS_EX_STAND_IN                  = 0x00000080  // TOOLWINDOW: no taskbar button
                                        | 0x08000000  // NOACTIVATE: never takes focus
                                        | 0x00200000  // NOREDIRECTIONBITMAP: DWM-only content
                                        | 0x00080000  // LAYERED: required for TRANSPARENT
                                        | 0x00000020; // TRANSPARENT: clicks pass through
    let LWA_ALPHA                       = 0x2;
    let SWP_SHOW                        = 0x0010 | 0x0040;          // NOACTIVATE | SHOWWINDOW
    let SWP_PLACE                       = 0x0004 | 0x0010 | 0x0200; // NOZORDER | NOACTIVATE | NOOWNERZORDER
    let DWMWA_TRANSITIONS_FORCEDISABLED = 3;
    let DWMWA_CLOAK                     = 13;
    let DWMWA_USE_IMMERSIVE_DARK_MODE   = 20;
    let DWMWA_WINDOW_CORNER_PREFERENCE  = 33;
    let DWMWA_SYSTEMBACKDROP_TYPE       = 38;
    let DWMSBT_NONE                     = 1;
    let DWM_TNP_UPDATE                  = 0x01 | 0x02 | 0x08 | 0x10; // RECTDESTINATION | RECTSOURCE | VISIBLE | SOURCECLIENTAREAONLY

    // Tuning
    let POPUP_CLASS        = "MozillaDropShadowWindowClass"; // Firefox's popup window class
    let STAND_IN_CLASS     = "ZenFlyoutMenusStandIn";
    let MAX_POPUP_WINDOWS  = 500; // safety cap when enumerating windows
    let FIND_FRAMES        = 12;  // frames to wait for Firefox to show the menu's window
    let SETTLE_FRAMES      = 20;  // longest wait for a menu to stop changing size
    let COLD_STEADY_FRAMES = 5;   // steady frames a menu's first open needs before rolling
    let CLOSE_FRAMES       = 30;  // longest wait for Firefox to hide a closed menu's window
    let PAINT_TIMEOUT_MS   = 120; // fallback if no paint event arrives
    let FLIP_SLACK_CSS     = 24;  // how far below the cursor a flipped menu's bottom may sit (submenus align to their item)

    // Elements
    let root       = document.documentElement;
    let main_hwnd  = nativeWindowHandle();
    let main_key   = keyOf(main_hwnd);
    let module     = GetModuleHandleW(null);
    let class_name = ctypes.char16_t.array()(STAND_IN_CLASS);
    let states     = new WeakMap(); // menupopup -> per-menu state, see stateOf()
    let stand_ins  = new Set();

    // =========================================================================
    // WIN32 SETUP
    // =========================================================================

    function loadWin32() {
        let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
        let user32     = ctypes.open("user32.dll");
        let kernel32   = ctypes.open("kernel32.dll");
        let dwmapi     = ctypes.open("dwmapi.dll");
        let abi        = ctypes.winapi_abi;
        let int        = ctypes.int32_t;
        let uint       = ctypes.uint32_t;
        let ptr        = ctypes.voidptr_t;
        let wstr       = ctypes.char16_t.ptr;
        let HWND       = ptr;

        let RECT       = new ctypes.StructType("RECT", [{ left: int }, { top: int }, { right: int }, { bottom: int }]);
        let POINT      = new ctypes.StructType("POINT", [{ x: int }, { y: int }]);
        let MARGINS    = new ctypes.StructType("MARGINS", [{ left: int }, { right: int }, { top: int }, { bottom: int }]);
        let WNDCLASSEX = new ctypes.StructType("WNDCLASSEXW", [
            { cbSize: uint }, { style: uint }, { lpfnWndProc: ptr }, { cbClsExtra: int }, { cbWndExtra: int },
            { hInstance: ptr }, { hIcon: ptr }, { hCursor: ptr }, { hbrBackground: ptr },
            { lpszMenuName: wstr }, { lpszClassName: wstr }, { hIconSm: ptr },
        ]);
        let THUMBNAIL  = new ctypes.StructType("DWM_THUMBNAIL_PROPERTIES", [
            { dwFlags: uint }, { rcDestination: RECT }, { rcSource: RECT },
            { opacity: ctypes.uint8_t }, { fVisible: int }, { fSourceClientAreaOnly: int },
        ]);

        return {
            ctypes, HWND, RECT, POINT, MARGINS, WNDCLASSEX, THUMBNAIL,
            libraries:                    [user32, kernel32, dwmapi],
            FindWindowExW:                user32.declare("FindWindowExW", abi, HWND, HWND, HWND, wstr, wstr),
            GetCursorPos:                 user32.declare("GetCursorPos", abi, int, POINT.ptr),
            GetWindow:                    user32.declare("GetWindow", abi, HWND, HWND, uint),
            GetWindowRect:                user32.declare("GetWindowRect", abi, int, HWND, RECT.ptr),
            IsWindow:                     user32.declare("IsWindow", abi, int, HWND),
            IsWindowVisible:              user32.declare("IsWindowVisible", abi, int, HWND),
            SetWindowPos:                 user32.declare("SetWindowPos", abi, int, HWND, HWND, int, int, int, int, uint),
            RegisterClassExW:             user32.declare("RegisterClassExW", abi, ctypes.uint16_t, WNDCLASSEX.ptr),
            CreateWindowExW:              user32.declare("CreateWindowExW", abi, HWND, uint, wstr, wstr, uint, int, int, int, int, HWND, ptr, ptr, ptr),
            SetLayeredWindowAttributes:   user32.declare("SetLayeredWindowAttributes", abi, int, HWND, uint, ctypes.uint8_t, uint),
            SendMessageW:                 user32.declare("SendMessageW", abi, ctypes.intptr_t, HWND, uint, ctypes.uintptr_t, ctypes.intptr_t),
            DestroyWindow:                user32.declare("DestroyWindow", abi, int, HWND),
            GetModuleHandleW:             kernel32.declare("GetModuleHandleW", abi, ptr, wstr),
            GetProcAddress:               kernel32.declare("GetProcAddress", abi, ptr, ptr, ctypes.char.ptr),
            DwmSetWindowAttribute:        dwmapi.declare("DwmSetWindowAttribute", abi, int, HWND, uint, ptr, uint),
            DwmGetWindowAttribute:        dwmapi.declare("DwmGetWindowAttribute", abi, int, HWND, uint, ptr, uint),
            DwmExtendFrameIntoClientArea: dwmapi.declare("DwmExtendFrameIntoClientArea", abi, int, HWND, MARGINS.ptr),
            DwmRegisterThumbnail:         dwmapi.declare("DwmRegisterThumbnail", abi, int, HWND, HWND, ptr.ptr),
            DwmUpdateThumbnailProperties: dwmapi.declare("DwmUpdateThumbnailProperties", abi, int, ptr, THUMBNAIL.ptr),
            DwmUnregisterThumbnail:       dwmapi.declare("DwmUnregisterThumbnail", abi, int, ptr),
        };
    }

    // The browser window's native handle; menu windows are owned by it
    function nativeWindowHandle() {
        let base_window = window.docShell.treeOwner
            .QueryInterface(Ci.nsIInterfaceRequestor)
            .getInterface(Ci.nsIAppWindow)
            .docShell.treeOwner
            .QueryInterface(Ci.nsIBaseWindow);

        return ctypes.cast(ctypes.uintptr_t(parseInt(base_window.nativeHandle, 16)), HWND);
    }

    // =========================================================================
    // WIN32 HELPERS
    // =========================================================================

    // cubic-bezier(0, 0, 0, 1) solved for y: x = s^3, y = 3s^2 - 2s^3
    function ease(progress) {
        let s = Math.cbrt(progress);
        return 3 * s * s - 2 * s * s * s;
    }

    // Window handles are compared by value; ctypes pointers are distinct objects
    function keyOf(hwnd) {
        return String(ctypes.cast(hwnd, ctypes.uintptr_t).value);
    }

    function setDwmInt(hwnd, attribute, value) {
        let boxed = ctypes.int32_t(value);
        DwmSetWindowAttribute(hwnd, attribute, boxed.address(), 4);
    }

    function getDwmInt(hwnd, attribute, fallback) {
        let boxed = ctypes.int32_t(fallback);
        return DwmGetWindowAttribute(hwnd, attribute, boxed.address(), 4) === 0 ? boxed.value : fallback;
    }

    function cloak(hwnd, on) {
        setDwmInt(hwnd, DWMWA_CLOAK, on ? 1 : 0);
    }

    function isOurPopupWindow(hwnd) {
        return IsWindow(hwnd) && keyOf(GetWindow(hwnd, GW_OWNER)) === main_key;
    }

    function windowRect(hwnd) {
        let r = RECT();
        GetWindowRect(hwnd, r.address());
        return { left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top };
    }

    function cursorY() {
        let point = POINT();
        return GetCursorPos(point.address()) ? point.y : null;
    }

    // Firefox popup windows owned by this browser window that pass test()
    function popupWindows(test) {
        let found = [];
        let hwnd  = FindWindowExW(null, null, POPUP_CLASS, null);
        let count = 0;

        while (!hwnd.isNull() && count++ < MAX_POPUP_WINDOWS) {
            if (isOurPopupWindow(hwnd) && test(hwnd)) {
                found.push(hwnd);
            }
            hwnd = FindWindowExW(null, hwnd, POPUP_CLASS, null);
        }

        return found;
    }

    // =========================================================================
    // STAND-IN WINDOW
    // =========================================================================

    // The class uses Windows' default window procedure, so no script ever runs
    // inside a window message. Browser windows share it, so it is registered on
    // first use and left registered.
    function registerStandInClass() {
        let window_class           = WNDCLASSEX();
        window_class.cbSize        = WNDCLASSEX.size;
        window_class.lpfnWndProc   = GetProcAddress(GetModuleHandleW("user32.dll"), "DefWindowProcW");
        window_class.hInstance     = module;
        window_class.lpszClassName = class_name;
        RegisterClassExW(window_class.address());
    }

    function createStandInWindow(rect) {
        return CreateWindowExW(WS_EX_STAND_IN, class_name, null, WS_POPUP, rect.left, rect.top, rect.width, 1, main_hwnd, null, module, null);
    }

    // A click-through window with the menu's backdrop, showing a live copy of the
    // cloaked real menu. Returns null if anything fails, and the menu then opens
    // without animation.
    function createStandIn(menu_hwnd, rect) {
        let hwnd = createStandInWindow(rect);
        if (hwnd.isNull()) {
            registerStandInClass();
            hwnd = createStandInWindow(rect);
        }
        if (hwnd.isNull()) {
            return null;
        }

        // Fully opaque; the layered style only exists so clicks pass through
        SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

        // Match the real menu's backdrop, theme and corners
        let glass    = MARGINS();
        let backdrop = getDwmInt(menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, 0);
        glass.left = glass.right = glass.top = glass.bottom = -1;
        DwmExtendFrameIntoClientArea(hwnd, glass.address());
        setDwmInt(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, getDwmInt(menu_hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 0));
        setDwmInt(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, getDwmInt(menu_hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, 0));
        setDwmInt(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, backdrop);

        // No Windows fade when the stand-in appears or goes away
        setDwmInt(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, 1);

        // Active backdrop, as Firefox does for its menus; otherwise it starts dimmer
        SendMessageW(hwnd, WM_NCACTIVATE, 1, -1);

        let thumbnail = ctypes.voidptr_t();
        if (DwmRegisterThumbnail(hwnd, menu_hwnd, thumbnail.address()) !== 0) {
            DestroyWindow(hwnd);
            return null;
        }

        // A cloaked window's backdrop renders flat and dark, and the thumbnail would
        // carry it over the stand-in's Mica. Only the contents are wanted, so the
        // real menu's backdrop is off while the stand-in is up.
        setDwmInt(menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_NONE);

        let stand_in = { hwnd, thumbnail, menu_hwnd, backdrop, shown: false };
        stand_ins.add(stand_in);
        return stand_in;
    }

    // Size and place the stand-in, showing the given slice of the real menu
    function placeStandIn(stand_in, left, top, width, height, source_top) {
        let properties                   = THUMBNAIL();
        properties.dwFlags               = DWM_TNP_UPDATE;
        properties.rcDestination.left    = 0;
        properties.rcDestination.top     = 0;
        properties.rcDestination.right   = width;
        properties.rcDestination.bottom  = height;
        properties.rcSource.left         = 0;
        properties.rcSource.top          = source_top;
        properties.rcSource.right        = width;
        properties.rcSource.bottom       = source_top + height;
        properties.fVisible              = 1;
        properties.fSourceClientAreaOnly = 0;
        DwmUpdateThumbnailProperties(stand_in.thumbnail, properties.address());

        SetWindowPos(stand_in.hwnd, null, left, top, width, height, stand_in.shown ? SWP_PLACE : SWP_SHOW);
        stand_in.shown = true;
    }

    // Remove the stand-in and give the real menu its backdrop back. Safe to call twice.
    function destroyStandIn(stand_in) {
        if (!stand_ins.delete(stand_in)) {
            return;
        }

        if (IsWindow(stand_in.menu_hwnd)) {
            setDwmInt(stand_in.menu_hwnd, DWMWA_SYSTEMBACKDROP_TYPE, stand_in.backdrop);
        }

        DwmUnregisterThumbnail(stand_in.thumbnail);
        DestroyWindow(stand_in.hwnd);
    }

    // =========================================================================
    // MENU HELPERS
    // =========================================================================

    // Per-menu state. generation increases on every open and close, so frames
    // queued for an earlier open drop out on their own.
    function stateOf(popup) {
        let state = states.get(popup);
        if (!state) {
            state = { generation: 0, frame: null, hwnd: null, cloaked: null, cursor_y: null, stand_in: null };
            states.set(popup, state);
        }
        return state;
    }

    function isOpen(popup) {
        return popup.state === "open" || popup.state === "showing";
    }

    // The menu's size from layout, in device pixels
    function layoutSize(popup) {
        let box = popup.getBoundingClientRect();
        let dpr = window.devicePixelRatio;
        return { width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) };
    }

    // Run on the next frame, unless the menu has since closed or reopened
    function nextFrame(state, generation, callback) {
        state.frame = requestAnimationFrame(now => {
            if (state.generation === generation) {
                callback(now);
            }
        });
    }

    // Run once Firefox has painted, with a fallback if no paint event arrives
    function afterPaint(state, generation, callback) {
        let done     = false;
        let run      = () => {
            if (!done) {
                done = true;
                window.removeEventListener("MozAfterPaint", run);
                nextFrame(state, generation, callback);
            }
        };

        window.addEventListener("MozAfterPaint", run);
        setTimeout(run, PAINT_TIMEOUT_MS);
    }

    // Uncloak every window cloaked on popupshowing except the menu's own
    function releaseOthers(state, keep) {
        let keep_key = keep ? keyOf(keep) : null;

        for (let hwnd of state.cloaked || []) {
            if (keyOf(hwnd) !== keep_key && IsWindow(hwnd)) {
                cloak(hwnd, false);
            }
        }

        state.cloaked = null;
    }

    function removeStandIn(state) {
        if (state.stand_in) {
            destroyStandIn(state.stand_in);
            state.stand_in = null;
        }
    }

    // =========================================================================
    // ROLL-OUT
    // =========================================================================

    // Find The Menu's Window
    // Wait until Firefox has shown the window at the menu's current size. If it
    // never matches, the real menu (not cloaked by then) simply shows as usual.
    function findWindow(popup, state, generation, tries) {
        // Another handler can cancel popupshowing, and then no popuphidden follows
        if (!isOpen(popup)) {
            releaseOthers(state, null);
            return;
        }

        let want = layoutSize(popup);
        let hwnd = null;

        if (want.height > 0) {
            hwnd = (state.cloaked || []).find(candidate => {
                if (!IsWindow(candidate) || !IsWindowVisible(candidate)) {
                    return false;
                }
                let size = windowRect(candidate);
                return Math.abs(size.width - want.width) <= 2 && Math.abs(size.height - want.height) <= 2;
            });
        }

        if (!hwnd && tries < FIND_FRAMES) {
            nextFrame(state, generation, () => findWindow(popup, state, generation, tries + 1));
            return;
        }

        releaseOthers(state, hwnd);

        if (!hwnd) {
            return;
        }

        // A menu's first open with this window may still be filling in items and icons
        let cold = !state.hwnd || keyOf(state.hwnd) !== keyOf(hwnd);
        state.hwnd = hwnd;

        afterPaint(state, generation, () => waitUntilSettled(popup, state, generation, hwnd, cold ? COLD_STEADY_FRAMES : 1, null, 0, 0));
    }

    // Wait For The Menu To Stop Changing Size
    // The stand-in copies the menu at the size it has when the roll starts, so
    // wait (still cloaked) until layout and window size hold steady.
    function waitUntilSettled(popup, state, generation, hwnd, needed, previous, steady, tries) {
        if (!isOpen(popup)) {
            return;
        }

        let layout  = layoutSize(popup);
        let actual  = windowRect(hwnd);
        let reading = [layout.width, layout.height, actual.left, actual.top, actual.width, actual.height].join();
        let count   = reading === previous ? steady + 1 : 0;

        if (count >= needed || tries >= SETTLE_FRAMES) {
            rollOut(popup, state, generation, hwnd);
            return;
        }

        nextFrame(state, generation, () => waitUntilSettled(popup, state, generation, hwnd, needed, reading, count, tries + 1));
    }

    // Roll The Menu Out
    function rollOut(popup, state, generation, hwnd) {
        if (!isOpen(popup)) {
            return;
        }

        // Where Firefox put the real menu, in device pixels. The roll ends exactly here.
        let rect   = windowRect(hwnd);
        let bottom = rect.top + rect.height;

        // Flipped upward: Firefox put the menu's bottom edge at the cursor instead of its top edge
        let click_y = state.cursor_y;
        let upward  = click_y !== null && rect.top < click_y && bottom <= click_y + FLIP_SLACK_CSS * window.devicePixelRatio;

        let stand_in = createStandIn(hwnd, rect);
        if (!stand_in) {
            cloak(hwnd, false);
            return;
        }
        state.stand_in = stand_in;

        let start = null;

        // Downward: top edge fixed, the menu's bottom slice shows, contents slide down.
        // Upward: bottom edge fixed, the menu's top slice shows, contents slide up.
        function show(height) {
            let h = Math.max(1, Math.min(rect.height, height));
            if (upward) {
                placeStandIn(stand_in, rect.left, bottom - h, rect.width, h, 0);
            } else {
                placeStandIn(stand_in, rect.left, rect.top, rect.width, h, rect.height - h);
            }
        }

        // popuphiding removes the stand-in a moment before generation changes
        function active() {
            return stand_ins.has(stand_in) && isOpen(popup);
        }

        function step(now) {
            if (!active()) {
                return;
            }

            if (start === null) {
                start = now;
            }

            let progress = Math.min((now - start) / duration, 1);
            show(Math.round(rect.height * ease(progress)));

            nextFrame(state, generation, progress < 1 ? step : follow);
        }

        // After the roll, keep the stand-in over the real menu if Firefox resizes or moves it
        function follow() {
            if (!active() || !IsWindow(hwnd)) {
                return;
            }

            let now = windowRect(hwnd);
            if (now.left !== rect.left || now.top !== rect.top || now.width !== rect.width || now.height !== rect.height) {
                rect = now;
                placeStandIn(stand_in, rect.left, rect.top, rect.width, rect.height, 0);
            }

            nextFrame(state, generation, follow);
        }

        nextFrame(state, generation, step);
    }

    // =========================================================================
    // EVENTS
    // =========================================================================

    // Hide The Menu Window Before It Shows
    function onShowing(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup" || matchMedia("(prefers-reduced-motion)").matches) {
            return;
        }

        let state      = stateOf(popup);
        let generation = ++state.generation;

        // The window exists before this event. Use the one seen last time, else
        // cloak every hidden popup window and sort it out once the menu shows.
        let known  = state.hwnd && isOurPopupWindow(state.hwnd) ? [state.hwnd] : null;
        let hidden = known || popupWindows(hwnd => !IsWindowVisible(hwnd));

        for (let hwnd of hidden) {
            cloak(hwnd, true);
        }

        state.cloaked  = hidden;
        state.cursor_y = cursorY();
        nextFrame(state, generation, () => findWindow(popup, state, generation, 0));
    }

    // Remove The Stand-In As Soon As The Menu Starts Closing
    function onHiding(event) {
        let popup = event.target;
        if (popup.localName === "menupopup" && states.has(popup)) {
            removeStandIn(states.get(popup));
        }
    }

    // Put Everything Back Once The Menu Has Closed
    function onHidden(event) {
        let popup = event.target;
        if (popup.localName !== "menupopup" || !states.has(popup)) {
            return;
        }

        let state      = states.get(popup);
        let generation = ++state.generation;
        let hwnd       = state.hwnd;
        let frames     = 0;

        if (state.frame) {
            cancelAnimationFrame(state.frame);
            state.frame = null;
        }

        removeStandIn(state);
        releaseOthers(state, null);

        // Firefox hides the window a moment after this event. Uncloaking earlier
        // would flash the empty menu for a frame.
        function uncloakOnceHidden() {
            if (!hwnd || !isOurPopupWindow(hwnd) || state.generation !== generation) {
                return;
            }
            if (IsWindowVisible(hwnd) && frames++ < CLOSE_FRAMES) {
                requestAnimationFrame(uncloakOnceHidden);
                return;
            }
            cloak(hwnd, false);
        }

        uncloakOnceHidden();
    }

    // Undo Everything When Sine Disables Or Uninstalls The Mod
    function unload() {
        root.removeEventListener("popupshowing", onShowing, true);
        root.removeEventListener("popuphiding", onHiding, true);
        root.removeEventListener("popuphidden", onHidden, true);

        for (let stand_in of Array.from(stand_ins)) {
            destroyStandIn(stand_in);
            if (IsWindow(stand_in.menu_hwnd)) {
                cloak(stand_in.menu_hwnd, false);
            }
        }

        for (let library of win32.libraries) {
            library.close();
        }
    }

    // Bind to Event Listeners
    root.addEventListener("popupshowing", onShowing, true);
    root.addEventListener("popuphiding", onHiding, true);
    root.addEventListener("popuphidden", onHidden, true);
    window.addUnloadListener?.(unload);
})();
