/** `import css from "./widget.css" with { type: "text" }`: Bun hands the file over as a string. */
declare module "*.css" {
  const text: string;
  export default text;
}
