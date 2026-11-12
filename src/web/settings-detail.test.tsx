import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Activity from "./Activity.tsx";
import Usage from "./Usage.tsx";
import AppModels from "./AppModels.tsx";
import Tasks from "./Tasks.tsx";
import Events from "./Events.tsx";

const noop = () => {};
// These pages exist only under Settings, so they render as its embedded detail.
const pages = {
  Activity: () => <Activity nameOf={(_kind, key) => key} />,
  Usage: () => <Usage />,
  AppModels: () => <AppModels selected={null} onSelect={noop} />,
  Events: () => <Events />,
  Tasks: () => <Tasks open embedded onClose={noop} onBack={noop} />,
};
for (const [name, Page] of Object.entries(pages)) {
  test(`${name} embeds without a nested dialog or duplicate navigation`, () => {
    const html = renderToStaticMarkup(<Page />);
    expect(html).toContain('class="settings-detail"');
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('class="overlay');
    expect(html).not.toContain('title="Close"');
    expect(html).not.toContain('title="Back"');
    expect(html).toContain('class="task-body"');
  });
}

// Tasks also opens as its own window (the shortcuts' "tasks" link).
test("Tasks retains standalone navigation", () => {
  const html = renderToStaticMarkup(<Tasks open onClose={noop} onBack={noop} />);
  expect(html).toContain('role="dialog"');
  expect(html).toContain('class="overlay"');
  expect(html).toContain('title="Close"');
  expect(html).toContain('title="Back"');
});
