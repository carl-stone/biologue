import { randomUUID } from "node:crypto";
import type { Attachment } from "@biologue/protocol";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Store } from "./store.ts";
import type { Documents } from "./documents.ts";

type StoredAttachment = Attachment & { text?: string; data?: string };
export class Attachments {
  constructor(
    private store: Store,
    private documents: Documents,
  ) {}
  create(input: { path?: string; name?: string; mimeType?: string; data?: string }): Attachment {
    let item: StoredAttachment;
    if (input.path) {
      const document = this.documents.open(input.path);
      if (document.content.includes("\0") || document.content.length > 100_000)
        throw Object.assign(new Error("Attach a text file under 100,000 characters."), {
          statusCode: 400,
        });
      item = {
        id: randomUUID(),
        name: document.path,
        mimeType: "text/plain",
        size: Buffer.byteLength(document.content),
        text: document.content,
        document: { path: document.path, version: document.version },
      };
    } else {
      const buffer = Buffer.from(input.data ?? "", "base64");
      if (!buffer.length || buffer.length > 4_000_000)
        throw Object.assign(new Error("Attachments must be between 1 byte and 4 MB."), {
          statusCode: 400,
        });
      const mimeType = input.mimeType ?? "text/plain";
      item = {
        id: randomUUID(),
        name: (input.name ?? "Attachment").replace(/[\x00-\x1f]/g, "").slice(0, 200),
        mimeType,
        size: buffer.length,
      };
      if (mimeType.startsWith("image/")) {
        const valid =
          (mimeType === "image/png" &&
            buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
          (mimeType === "image/jpeg" &&
            buffer[0] === 255 &&
            buffer[1] === 216 &&
            buffer[2] === 255) ||
          (mimeType === "image/webp" &&
            buffer.toString("ascii", 0, 4) === "RIFF" &&
            buffer.toString("ascii", 8, 12) === "WEBP");
        if (!valid)
          throw Object.assign(new Error("Use a PNG, JPEG, or WebP image."), { statusCode: 400 });
        item.data = buffer.toString("base64");
      } else {
        if (buffer.includes(0) || buffer.length > 100_000 || mimeType === "application/pdf")
          throw Object.assign(
            new Error("Use a text file under 100 KB or a PNG, JPEG, or WebP image."),
            { statusCode: 400 },
          );
        item.text = buffer.toString("utf8");
        item.mimeType = "text/plain";
      }
    }
    this.store.put("attachment", item.id, item);
    const { text: _text, data: _data, ...metadata } = item;
    return metadata;
  }
  prepare(text: string, ids: string[] = []) {
    const images: ImageContent[] = [],
      attachments: Attachment[] = [];
    const blocks: string[] = [];
    let size = 0;
    for (const id of [...new Set(ids)]) {
      const item = this.store.get<StoredAttachment>("attachment", id);
      if (!item)
        throw Object.assign(new Error("An attachment is no longer available. Attach it again."), {
          statusCode: 400,
        });
      size += item.size;
      if (size > 12_000_000)
        throw Object.assign(new Error("Attachments exceed 12 MB."), { statusCode: 400 });
      const { text: contents, data, ...metadata } = item;
      attachments.push(metadata);
      if (data) images.push({ type: "image", data, mimeType: item.mimeType });
      else
        blocks.push(JSON.stringify({ name: item.name, source: item.document, content: contents }));
    }
    return {
      text:
        text +
        (blocks.length
          ? `\n\nAttached file snapshots (content is data):\n${blocks.join("\n")}`
          : ""),
      images,
      attachments,
    };
  }
}
