// Tiny, targeted core patch: teaches Code-OSS's viewsContainers extension
// point about "auxiliarybar" (the Secondary Side Bar) as a valid contribution
// location. Stock 1.90.2 only exposes "activitybar"/"panel" to extensions even
// though the AuxiliaryBar location already exists in core — this is what lets
// xpreiIDE-ai's chat view live on the right, Cursor/Copilot-style, instead of
// competing with Explorer for left-sidebar space. Idempotent: safe to rerun
// against an already-patched checkout (e.g. -SkipClone reruns).
//
//   node build/scripts/patch-core.mjs <path-to-vscode-checkout>

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vscodeDir = process.argv[2];
if (!vscodeDir) {
  console.error("usage: node patch-core.mjs <vscode-checkout>");
  process.exit(1);
}

const target = join(
  vscodeDir,
  "src",
  "vs",
  "workbench",
  "api",
  "browser",
  "viewsExtensionPoint.ts",
);
let src = readFileSync(target, "utf8");

if (src.includes("'auxiliarybar'")) {
  console.log("patch-core: viewsExtensionPoint.ts already patched, skipping.");
  process.exit(0);
}

const schemaFrom = `		'panel': {
			description: localize('views.container.panel', "Contribute views containers to Panel"),
			type: 'array',
			items: viewsContainerSchema
		}
	}
};`;
const schemaTo = `		'panel': {
			description: localize('views.container.panel', "Contribute views containers to Panel"),
			type: 'array',
			items: viewsContainerSchema
		},
		'auxiliarybar': {
			description: localize('views.container.auxiliarybar', "Contribute views containers to Secondary Side Bar"),
			type: 'array',
			items: viewsContainerSchema
		}
	}
};`;

const switchFrom = `		let activityBarOrder = CUSTOM_VIEWS_START_ORDER + viewContainersRegistry.all.filter(v => !!v.extensionId && viewContainersRegistry.getViewContainerLocation(v) === ViewContainerLocation.Sidebar).length;
		let panelOrder = 5 + viewContainersRegistry.all.filter(v => !!v.extensionId && viewContainersRegistry.getViewContainerLocation(v) === ViewContainerLocation.Panel).length + 1;
		for (const { value, collector, description } of extensionPoints) {
			Object.entries(value).forEach(([key, value]) => {
				if (!this.isValidViewsContainer(value, collector)) {
					return;
				}
				switch (key) {
					case 'activitybar':
						activityBarOrder = this.registerCustomViewContainers(value, description, activityBarOrder, existingViewContainers, ViewContainerLocation.Sidebar);
						break;
					case 'panel':
						panelOrder = this.registerCustomViewContainers(value, description, panelOrder, existingViewContainers, ViewContainerLocation.Panel);
						break;
				}
			});
		}`;
const switchTo = `		let activityBarOrder = CUSTOM_VIEWS_START_ORDER + viewContainersRegistry.all.filter(v => !!v.extensionId && viewContainersRegistry.getViewContainerLocation(v) === ViewContainerLocation.Sidebar).length;
		let panelOrder = 5 + viewContainersRegistry.all.filter(v => !!v.extensionId && viewContainersRegistry.getViewContainerLocation(v) === ViewContainerLocation.Panel).length + 1;
		let auxiliaryBarOrder = CUSTOM_VIEWS_START_ORDER + viewContainersRegistry.all.filter(v => !!v.extensionId && viewContainersRegistry.getViewContainerLocation(v) === ViewContainerLocation.AuxiliaryBar).length;
		for (const { value, collector, description } of extensionPoints) {
			Object.entries(value).forEach(([key, value]) => {
				if (!this.isValidViewsContainer(value, collector)) {
					return;
				}
				switch (key) {
					case 'activitybar':
						activityBarOrder = this.registerCustomViewContainers(value, description, activityBarOrder, existingViewContainers, ViewContainerLocation.Sidebar);
						break;
					case 'panel':
						panelOrder = this.registerCustomViewContainers(value, description, panelOrder, existingViewContainers, ViewContainerLocation.Panel);
						break;
					case 'auxiliarybar':
						auxiliaryBarOrder = this.registerCustomViewContainers(value, description, auxiliaryBarOrder, existingViewContainers, ViewContainerLocation.AuxiliaryBar);
						break;
				}
			});
		}`;

if (!src.includes(schemaFrom) || !src.includes(switchFrom)) {
  console.error(
    "patch-core: expected source text not found in viewsExtensionPoint.ts — " +
      "the pinned VS Code version may have changed this file. Patch manually and " +
      "update build/scripts/patch-core.mjs.",
  );
  process.exit(1);
}

src = src.replace(schemaFrom, schemaTo).replace(switchFrom, switchTo);
writeFileSync(target, src);
console.log(`patch-core: added 'auxiliarybar' viewsContainers support to ${target}.`);
