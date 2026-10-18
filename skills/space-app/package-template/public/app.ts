// Relative URLs only: ai-space serves the app under an origin of its own.
const res = await fetch("api/hello");
const data = (await res.json()) as { message: string };
document.querySelector("#message")!.textContent = data.message;
