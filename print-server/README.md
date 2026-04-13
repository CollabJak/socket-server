# POS Print Server (Optional)

Simple Node print bridge for ESC/POS over TCP (`9100`).

## Run

```bash
cd socket-server/print-server
npm install
npm start
```

## Environment

- `PRINT_SERVER_PORT` (default `3201`)
- `PRINTER_HOST` (default `127.0.0.1`)
- `PRINTER_PORT` (default `9100`)
- `RECEIPT_WIDTH` (default `32`)

## API

`POST /print`

```json
{
  "receipt": {
    "header": { "business_name": "Demo", "address": "-", "date": "2026-04-01 10:00:00", "invoice": "POS-00000001", "cashier": "Admin" },
    "items": [{ "name": "Coffee", "qty": 1, "price": 10000, "total": 10000 }],
    "summary": { "subtotal": 10000, "total": 10000, "paid": 20000, "change": 10000 },
    "footer": { "note": "Thank you" }
  },
  "printerHost": "192.168.1.10",
  "printerPort": 9100,
  "width": 32
}
```
