import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf";
import Gtk from "gi://Gtk?version=4.0";
import { resolveUrl, sameOrigin } from "../core/url.ts";
import { type GBytes, type SpaceClient, plainRequest } from "./http.ts";
import { APP_ROOT, path } from "./env.ts";

/**
 * Icons of apps, agents and widgets: an emoji drawn as text, or an image (a URL, or a path on the
 * Space fetched with its session). Decoded with GdkPixbuf, so SVG, PNG, JPEG and WebP all work
 * where their loaders are installed. Textures are kept for the life of the process.
 */

const textures = new Map<string, Promise<any | undefined>>();

export const isImageIcon = (icon: string | undefined) => Boolean(icon) && (/^(https?:)?\/\//.test(icon!) || icon!.startsWith("/"));

function decode(bytes: GBytes, size: number): any | undefined {
  try {
    const loader = new GdkPixbuf.PixbufLoader();
    // Vector icons are drawn at twice the size for sharp scaling.
    loader.connect("size-prepared", (_l: unknown, w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const target = size * 2;
      if (Math.max(w, h) > target || loader.get_format()?.get_name() === "svg") {
        const k = target / Math.max(w, h);
        loader.set_size(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
      }
    });
    loader.write_bytes(bytes);
    loader.close();
    const pixbuf = loader.get_pixbuf();
    return pixbuf ? Gdk.Texture.new_for_pixbuf(pixbuf) : undefined;
  } catch {
    return undefined;
  }
}

export function loadTexture(icon: string, client: SpaceClient | undefined, size = 64): Promise<any | undefined> {
  const url = client ? (resolveUrl(icon, `${client.base}/`) ?? icon) : icon;
  const key = `${url}@${size}`;
  let p = textures.get(key);
  if (!p) {
    p = (async () => {
      try {
        const bytes = client && sameOrigin(url, client.base) ? await client.bytes(url) : (await plainRequest("GET", url, { Accept: "image/*" })).bytes;
        return decode(bytes, size);
      } catch {
        return undefined;
      }
    })();
    textures.set(key, p);
    // A failure is tried again on a later draw, not remembered.
    void p.then((t) => t || textures.delete(key));
  }
  return p;
}

/** A texture of a file shipped with the app (`data/…`). */
export function appTexture(name: string): any | undefined {
  try {
    return Gdk.Texture.new_from_filename(path(APP_ROOT, "data", name));
  } catch {
    return undefined;
  }
}

/** An icon as a widget of `size` pixels: an emoji label, the image once it has loaded, or the fallback glyph. */
export function iconWidget(icon: string | undefined, size: number, client: SpaceClient | undefined, fallback = "application-x-executable-symbolic"): any {
  const box = new Gtk.Box({ width_request: size, height_request: size, halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER });
  box.add_css_class("tile-icon");
  const glyph = () => {
    const img = new Gtk.Image({ icon_name: fallback, pixel_size: Math.round(size * 0.6), hexpand: true, vexpand: true });
    img.add_css_class("dim-label");
    return img;
  };
  if (icon && !isImageIcon(icon)) {
    const label = new Gtk.Label({ label: icon, hexpand: true, vexpand: true });
    label.add_css_class("tile-emoji");
    label.set_markup(`<span size="${Math.round(size * 0.62)}pt">${icon.replace(/[&<>]/g, "")}</span>`);
    box.append(label);
    return box;
  }
  let shown = glyph();
  box.append(shown);
  if (icon) {
    void loadTexture(icon, client, size).then((texture) => {
      if (!texture) return;
      const pic = new Gtk.Picture({ paintable: texture, content_fit: Gtk.ContentFit.CONTAIN, can_shrink: true, width_request: size, height_request: size });
      pic.add_css_class("tile-image");
      box.remove(shown);
      shown = pic;
      box.append(pic);
    });
  }
  return box;
}
