import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Activity from "./Activity.tsx";
import Usage from "./Usage.tsx";
import AppModels from "./AppModels.tsx";
import Tasks from "./Tasks.tsx";
import Events from "./Events.tsx";

const noop = () => {};
const pages = { Activity, Usage, AppModels, Tasks, Events };
for (const [name, Page] of Object.entries(pages)) {
  test(`${name} embeds without a nested dialog or duplicate navigation`, () => {
    const html = renderToStaticMarkup(<Page open embedded onClose={noop} onBack={noop} nameOf={(_kind, key) => key} />);
    expect(html).toContain('class="settings-detail"');
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('class="overlay');
    expect(html).not.toContain('title="Close"');
    expect(html).not.toContain('title="Back"');
    expect(html).toContain('class="task-body"');
  });
  test(`${name} retains standalone navigation`, () => {
    const html = renderToStaticMarkup(<Page open onClose={noop} onBack={noop} nameOf={(_kind, key) => key} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('class="overlay"');
    expect(html).toContain('title="Close"');
    expect(html).toContain('title="Back"');
  });
}
