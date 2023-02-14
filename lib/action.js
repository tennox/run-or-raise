const Main = imports.ui.main;
const { Meta, Shell, St, Gdk, Gio, Clutter } = imports.gi
const { spawnCommandLine } = imports.misc.util
const ExtensionUtils = imports.misc.extensionUtils
const Me = ExtensionUtils.getCurrentExtension()

const Mode = Me.imports.lib.mode.Mode

var Action = class {

    /**
     * Single shortcut binding representation
     * @param {String} command
     * @param {String} wm_class
     * @param {String} title
     * @param {Mode} mode
     * @param {String} shortcut_bare
     * @param {String[]} layers
     */
    constructor(command = "", wm_class = "", title = "", mode = null, shortcut_bare = "", layers = []) {
        this.command = command
        this.wm_class = wm_class || ""  // may be undefined when user does not set enough parameters
        this.title = title || ""  // may be undefined when user does not set enough parameters
        this.mode = mode
        this.wmFn = null
        this.titleFn = null;
        [this.wm_class, this.wmFn] = this._allow_regex(wm_class);
        [this.title, this.titleFn] = this._allow_regex(title);
        /**
         * @type {String[]} `<Super>g a b,command` → ["a", "b"]
         */
        this.layers = layers || []

        /**
         * Is the actions depend on the keyboard-lock state
         * @type {?boolean}
         */
        this.num_lock = this.caps_lock = this.scroll_lock = null;

        /**
         * @type {String}
         */
        this.shortcut = this._set_shortcut(shortcut_bare)

        /**
         * Shortcuts remembers the windows it is bind to
         * @type {window}
         */
        this.registered_window = null;
    }

    /**
     * Return appropriate method for s, depending if s is a regex (search) or a string (indexOf)
     * @param s
     * @return {(string|string)[]|(RegExp|string)[]} Tuple
     * @private
     */
    _allow_regex(s) {
        if (s.substr(0, 1) === "/" && s.slice(-1) === "/") {
            // s is surround with slashes, ex: `/my-program/`, we want to do a regular match when searching
            return [new RegExp(s.substr(1, s.length - 2)), "search"]
        } else {  // s is a classic string (even empty), we just do indexOf match
            return [s, "indexOf"]
        }
    }

    debug() {
        if (!this.mode.get(Mode.VERBOSE)) {
            return
        }
        let s = "Run-or-raise>"
        for (let a of arguments) {
            s += " " + a
        }
        Main.notify(s)
    }


    /**
     * @return {*} Current windows
     */
    get_windows() {
        // Switch windows on active workspace only
        const workspace_manager = global.display.get_workspace_manager()
        const active_workspace = this.mode.get(Mode.ISOLATE_WORKSPACE) ? workspace_manager.get_active_workspace() : null

        // fetch windows
        return global.display.get_tab_list(0, active_workspace)
    }


    is_conforming(window) {
        let [command, wm_class, wmFn, title, titleFn] = [this.command, this.wm_class, this.wmFn, this.title, this.titleFn];

        const window_class = window.get_wm_class() || '';
        const window_title = window.get_title() || '';
        // check if the current window is conforming to the search criteria
        if (wm_class) { // seek by class wm_class AND if set, title must match
            if (window_class[wmFn](wm_class) > -1 && (!title || window_title[titleFn](title) > -1)) {
                return true;
            }
        } else if ((title && window_title[titleFn](title) > -1) || // seek by title
            (!title && ((window_class.toLowerCase().indexOf(command.toLowerCase()) > -1) || // seek by launch-command in wm_class
                (window_title.toLowerCase().indexOf(command.toLowerCase()) > -1))) // seek by launch-command in title
        ) {
            return true;
        }
        return false;
    }

    /**
     *
     * @param window
     * @param check if true, we focus only if the window is listed amongst current windows
     * @return {boolean}
     */
    focus_window(window, check = false) {
        if (check
            && (!window  // gnome shell reloaded and window IDs changed (even if window might be still there)
                || !this.get_windows().filter(w => w.get_id() == window.get_id()).length // window closed
            )) {
            this.debug("Window not found")
            return false
        }

        if (this.mode.get(Mode.MOVE_WINDOW_TO_ACTIVE_WORKSPACE)) {
            const activeWorkspace = global.workspaceManager.get_active_workspace();
            window.change_workspace(activeWorkspace);
        }
        window.get_workspace().activate_with_focus(window, true)
        window.activate(0)
        if (this.mode.get(Mode.CENTER_MOUSE_TO_FOCUSED_WINDOW)) {
            const { x, y, width, height } = window.get_frame_rect()
            seat.warp_pointer(x + width / 2, y + height / 2)
        }
        this.debug("Window activated")
        return true
    }

    /**
     * Trigger the shortcut (system does it)
     * @return {boolean|*}
     */
    trigger() {
        let mode = this.mode;

        // Debug info
        this.debug(`trigger title: ${this.title}, titleFn: ${this.titleFn}, wm_class: ${this.wm_class}, wmFn: ${this.wmFn}`);

        // Check raising keywords
        let i
        if ((i = mode.get(Mode.RAISE_OR_REGISTER))) {
            if (!this.registered_window || !this.focus_window(this.registered_window, true)) {
                this.registered_window = this.get_windows()[0]
            }
            return
        }
        if ((i = mode.get(Mode.REGISTER))) {
            return register[i] = this.get_windows()[0]  // will stay undefined if there is no such window
        }
        if ((i = mode.get(Mode.RAISE))) {
            return this.focus_window(register[i], true)
        }

        // Check if the shortcut should just run without raising a window
        if (mode.get(Mode.RUN_ONLY)) {
            return this.run()
        }

        /**
         * @type {window}
         */
        let seen = null;
        const windows = this.get_windows()
        // if window conforms, let's focus the oldest windows of the group
        // (otherwise we find the youngest conforming one)
        const ordered = (windows.length && this.is_conforming(windows[0])) ?
            windows.slice(0).reverse() : windows
        let window
        for (window of ordered) {
            if (this.is_conforming(window)) {
                seen = window;
                if (!seen.has_focus()) {
                    break; // there might exist another window having the same parameters
                }
            }
        }
        if (seen) {
            if (!seen.has_focus()) {
                this.focus_window(seen);
            } else {
                if (mode.get(Mode.MINIMIZE_WHEN_UNFOCUSED)) {
                    seen.minimize();
                }
                if (mode.get(Mode.SWITCH_BACK_WHEN_FOCUSED)) {
                    const window_monitor = window.get_monitor();
                    const window_list = windows.filter(w => w.get_monitor() === window_monitor && w !== window)
                    const last_window = window_list[0];
                    if (last_window) {
                        this.focus_window(last_window);
                    }
                }
            }
        }
        if (!seen || mode.get(Mode.ALWAYS_RUN)) {
            this.run();
        }
    }

    run() {
        if (this.mode.get(Mode.VERBOSE)) {
            this.debug("running:", this.command)
        }
        const app = Shell.AppSystem.get_default().lookup_app(this.command);
        if (app !== null) {
            return app.activate();
        }
        return spawnCommandLine(this.command);
    }

    /**
     * Parse non-standard modifiers
     * @param shortcut
     * @return {*} Return the shortcut with the non-standard modifiers removed
     */
    _set_shortcut(shortcut) {

        const included = (sym) => {
            if (shortcut.includes(`<${sym}>`)) {
                shortcut = shortcut.replace(`<${sym}>`, "")
                return true
            }
            if (shortcut.includes(`<${sym}_OFF>`)) {
                shortcut = shortcut.replace(`<${sym}_OFF>`, "")
                return false
            }
            return null
        }

        this.num_lock = included("Num_Lock")
        this.caps_lock = included("Caps_Lock")
        this.scroll_lock = included("Scroll_Lock")

        return shortcut.trim()
    }

    /**
     *
     * @return {*[]} Array of true/false/null
     */
    get_state() {
        return [this.num_lock, this.caps_lock, this.scroll_lock]
    }


    /**
     * Is the shortcut valid in the current keyboard state?
     * @param {State} state_system Array of true/false
     * @return {boolean} True if all boolean values matches whereas null values in this.get_state() are ignored.
     */
    state_conforms(state_system) {
        const state_action = this.get_state()
        for (let i = 0; i < state_action.length; i++) {
            if (state_action[i] === null) {
                continue
            }
            if (state_action[i] !== state_system[i]) {
                return false
            }
        }
        return true
    }

    static parseLine(line) {
        // Optional argument quoting in the format: `shortcut[:mode][:mode],[command],[wm_class],[title]`
        // ', b, c, "d, e,\" " f", g, h' -> ["", "b", "c", "d, e,\" \" f", "g", "h"]
        const args = line.split(/,(?![^"]*"(?:(?:[^"]*"){2})*[^"]*$)/)
            .map(s => s.trim())
            .map(s => (s[0] === '"' && s.slice(-1) === '"') ? s.slice(1, -1).trim() : s) // remove quotes
        const [shortcut_layer_mode, command, wm_class, title] = args

        // Split shortcut[:mode][:mode] -> shortcut, mode
        const [shortcut_layer, ...modes] = shortcut_layer_mode.split(":")
        const [shortcut_bare, ...layers] = shortcut_layer.split(" ")
        // Store to "shortcut:cmd:launch(2)" → new Mode([["cmd", true], ["launch": 2]])
        const mode = new Mode(modes
            .map(m => m.match(/(?<key>[^(]*)(\((?<arg>.*?)\))?/)) // "launch" -> key=launch, arg=undefined
            .filter(m => m) // "launch" must be a valid mode string
            .map(m => [m.groups.key, m.groups.arg || true])  // ["launch", true]
        )
        if (args.length <= 2) { // Run only mode, we never try to raise a window
            mode.add(Mode.RUN_ONLY, true)
        }
        return new Action(command, wm_class, title, mode, shortcut_bare, layers)
    }
}