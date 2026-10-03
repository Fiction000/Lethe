import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

declare const __filename: string;

class FakeDocument {
  activeElement: FakeElement | null = null;
}

class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  value = '';
  maxLength = -1;
  textContent = '';
  connected = false;

  constructor(readonly ownerDocument: FakeDocument) {}

  createDiv(_options?: unknown): FakeElement {
    return this.append(new FakeElement(this.ownerDocument));
  }

  createEl(_tag: string, _options?: unknown): FakeElement {
    return this.append(new FakeElement(this.ownerDocument));
  }

  empty(): void {
    const activeElement = this.ownerDocument.activeElement;
    if (activeElement !== null && this.contains(activeElement)) {
      this.ownerDocument.activeElement = null;
    }
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  isConnected(): boolean {
    return this.connected || (this.parent !== null && this.parent.isConnected());
  }

  private append(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  private contains(target: FakeElement): boolean {
    return this.children.some((child) => child === target || child.contains(target));
  }
}

class FakeTextComponent {
  readonly inputEl: FakeElement;
  private changeHandler?: (value: string) => void;

  constructor(containerEl: FakeElement) {
    this.inputEl = containerEl.createEl('input');
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setPlaceholder(_value: string): this {
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.changeHandler = callback;
    return this;
  }

  type(value: string): void {
    this.inputEl.value = value;
    this.changeHandler?.(value);
  }
}

class FakeSetting {
  static readonly textComponents: FakeTextComponent[] = [];
  private readonly rowEl: FakeElement;

  constructor(containerEl: FakeElement) {
    this.rowEl = containerEl.createDiv();
  }

  setName(_name: string): this {
    return this;
  }

  setDesc(_description: string): this {
    return this;
  }

  addText(callback: (component: FakeTextComponent) => void): this {
    const component = new FakeTextComponent(this.rowEl);
    FakeSetting.textComponents.push(component);
    callback(component);
    return this;
  }

  addDropdown(
    callback: (dropdown: {
      addOption(value: string, label: string): unknown;
      setValue(value: string): unknown;
      setDisabled(disabled: boolean): unknown;
      onChange(handler: (value: string) => void): unknown;
    }) => void,
  ): this {
    const dropdown = {
      addOption: () => dropdown,
      setValue: () => dropdown,
      setDisabled: () => dropdown,
      onChange: () => dropdown,
    };
    callback(dropdown);
    return this;
  }

  addButton(
    callback: (button: {
      setButtonText(value: string): unknown;
      setWarning(): unknown;
      setCta(): unknown;
      onClick(handler: () => void): unknown;
    }) => void,
  ): this {
    const button = {
      setButtonText: () => button,
      setWarning: () => button,
      setCta: () => button,
      onClick: () => button,
    };
    callback(button);
    return this;
  }
}

const requireFromTest = createRequire(__filename);
const moduleLoader = requireFromTest('node:module') as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithObsidianStub(request, parent, isMain) {
  if (request === 'obsidian') {
    return { Setting: FakeSetting, SecretComponent: undefined };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let settingsModule: typeof import('../src/obComponents/JevSettingsSection');
try {
  settingsModule = requireFromTest(
    '../src/obComponents/JevSettingsSection',
  ) as typeof import('../src/obComponents/JevSettingsSection');
} finally {
  moduleLoader._load = originalLoad;
}

const { JEV_DISCLOSURE, JevSettingsSection } = settingsModule;

test('discloses every capture field sent to TypeSafe', () => {
  assert.match(JEV_DISCLOSURE, /submitted body/i);
  assert.match(JEV_DISCLOSURE, /profile/i);
  assert.match(JEV_DISCLOSURE, /fields/i);
  assert.match(JEV_DISCLOSURE, /added tags/i);
  assert.match(JEV_DISCLOSURE, /removed tags/i);
  assert.match(JEV_DISCLOSURE, /sent to TypeSafe/i);
});

test('keeps the model input attached and focused while its value changes', () => {
  FakeSetting.textComponents.length = 0;
  const document = new FakeDocument();
  const containerEl = new FakeElement(document);
  containerEl.connected = true;
  const section = new JevSettingsSection({
    app: {
      secretStorage: {
        getSecret: () => null,
        setSecret: () => undefined,
        listSecrets: () => [],
      },
    } as never,
    containerEl: containerEl as never,
    settings: {
      mode: 'off',
      model: 'jev-latest',
      secretId: 'lethe-typesafe',
      approvedTags: [],
    },
    onChange: () => undefined,
  });
  section.render();

  const modelInput = FakeSetting.textComponents.find(({ inputEl }) => inputEl.value === 'jev-latest');
  assert.ok(modelInput, 'model input should be rendered');
  const originalInputEl = modelInput.inputEl;
  originalInputEl.focus();

  modelInput.type('jev-latest-custom');

  assert.strictEqual(document.activeElement, originalInputEl);
  assert.equal(originalInputEl.isConnected(), true);
});
