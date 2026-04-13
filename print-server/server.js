const http = require("http");
const net = require("net");

const DEFAULT_PORT = Number(process.env.PRINT_SERVER_PORT || 3201);
const DEFAULT_PRINTER_HOST = process.env.PRINTER_HOST || "127.0.0.1";
const DEFAULT_PRINTER_PORT = Number(process.env.PRINTER_PORT || 9100);
const DEFAULT_WIDTH = Number(process.env.RECEIPT_WIDTH || 32);

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

const formatLine = (left, right, width = 32) => {
  const safeWidth = Math.max(8, Math.floor(width));
  const l = String(left || "").replace(/\s+/g, " ").trim();
  const r = String(right || "").replace(/\s+/g, " ").trim();

  if (r.length >= safeWidth) {
    return r.slice(0, safeWidth);
  }

  const gap = 1;
  const maxLeft = Math.max(0, safeWidth - r.length - gap);
  const clippedLeft =
    l.length <= maxLeft ? l : maxLeft <= 3 ? l.slice(0, maxLeft) : `${l.slice(0, maxLeft - 3)}...`;
  const spaces = Math.max(gap, safeWidth - clippedLeft.length - r.length);
  return `${clippedLeft}${" ".repeat(spaces)}${r}`;
};

const center = (text, width) => {
  const t = String(text || "").trim();
  if (t.length >= width) return t.slice(0, width);
  const leftPad = Math.max(0, Math.floor((width - t.length) / 2));
  return `${" ".repeat(leftPad)}${t}`;
};

const toMoney = (value) => {
  const amount = Number(value);
  const formatted = Number.isFinite(amount)
    ? new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount)
    : "0";

  return `Rp. ${formatted}`;
};

const wrap = (text, width) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines = [];
  let current = "";

  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }

    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
};

const toReceiptText = (payload, width = DEFAULT_WIDTH) => {
  const ruler = "-".repeat(width);
  const lines = [
    center(payload?.header?.business_name || "Business", width),
    center(payload?.header?.address || "-", width),
    ruler,
    formatLine("Date", payload?.header?.date || "-", width),
    formatLine("Invoice", payload?.header?.invoice || "-", width),
    formatLine("Cashier", payload?.header?.cashier || "-", width),
    ruler,
  ];

  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    lines.push(...wrap(item?.name || "", width));
    lines.push(formatLine(`${item?.qty || 0} x ${toMoney(item?.price || 0)}`, toMoney(item?.total || 0), width));
  }

  lines.push(
    ruler,
    formatLine("Subtotal", toMoney(payload?.summary?.subtotal || 0), width),
    formatLine("Total", toMoney(payload?.summary?.total || 0), width),
    formatLine("Paid", toMoney(payload?.summary?.paid || 0), width),
    formatLine("Change", toMoney(payload?.summary?.change || 0), width),
    ruler,
    center(payload?.footer?.note || "Thank you", width)
  );

  return `${lines.join("\n")}\n\n`;
};

const buildEscPosBuffer = (payload, width) => {
  const init = Buffer.from([0x1b, 0x40]); // ESC @
  const alignLeft = Buffer.from([0x1b, 0x61, 0x00]); // ESC a 0
  const text = Buffer.from(toReceiptText(payload, width), "ascii");
  const feedAndCut = Buffer.from([0x1d, 0x56, 0x41, 0x03]); // GS V A n
  return Buffer.concat([init, alignLeft, text, feedAndCut]);
};

const sendToPrinter = ({ host, port, buffer }) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(buffer);
      socket.end();
    });

    socket.setTimeout(5000);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Printer timeout"));
    });
    socket.on("error", (error) => reject(error));
    socket.on("close", () => resolve());
  });

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "POST" || req.url !== "/print") {
    return json(res, 404, { ok: false, message: "Not found" });
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const receipt = parsed.receipt;
      if (!receipt || typeof receipt !== "object") {
        return json(res, 422, { ok: false, message: "receipt payload is required" });
      }

      const printerHost = String(parsed.printerHost || DEFAULT_PRINTER_HOST);
      const printerPort = Number(parsed.printerPort || DEFAULT_PRINTER_PORT);
      const width = Number(parsed.width || DEFAULT_WIDTH);

      const escposBuffer = buildEscPosBuffer(receipt, width);
      await sendToPrinter({
        host: printerHost,
        port: printerPort,
        buffer: escposBuffer,
      });

      return json(res, 200, {
        ok: true,
        message: "Printed",
        printerHost,
        printerPort,
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        message: error instanceof Error ? error.message : "Print failed",
      });
    }
  });
});

server.listen(DEFAULT_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Print server running on :${DEFAULT_PORT}`);
});
