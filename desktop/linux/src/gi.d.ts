// GJS's GObject-introspection imports (GTK 4, libadwaita, WebKitGTK 6, libsoup 3, libsecret).
// They are typed loosely: the app layer is thin glue, and the logic it drives lives in core/,
// which is fully typed and tested with Bun. Generating full bindings (@girs/*) would add a large
// dependency for little gain at this size.
declare module "gi://*" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lib: any;
  export default lib;
}

declare module "system" {
  const System: { programArgs: string[]; programInvocationName: string; exit(code: number): never };
  export default System;
}

declare function print(...args: unknown[]): void;
declare function printerr(...args: unknown[]): void;
declare const ARGV: string[];
