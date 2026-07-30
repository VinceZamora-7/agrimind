import Clutter from 'gi://Clutter';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Keyboard from 'resource:///org/gnome/shell/ui/keyboard.js';

export default class ForceTerminalOskExtension extends Extension {
    enable() {
        this._injectionManager = new InjectionManager();
        this._injectionManager.overrideMethod(
            Keyboard.Keyboard.prototype,
            '_updateLayout',
            originalMethod => function (groupName, _purpose) {
                return originalMethod.call(this, groupName, Clutter.InputContentPurpose.TERMINAL);
            });
    }

    disable() {
        this._injectionManager?.clear();
        this._injectionManager = null;
    }
}
