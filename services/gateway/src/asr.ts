import { Ws } from "@open-assistant/protocol"

export type AsrMessage = Ws.AsrPartial | Ws.AsrFinal

export type AsrConnection = {
  ready: Promise<void>
  send: (msg: Ws.AudioIn) => void
  close: () => void
}

export function connectAsr(
  cfg: { url: string },
  sessionID: string,
  onAsr: (msg: AsrMessage) => void,
): AsrConnection {
  const url = new URL(cfg.url)
  url.searchParams.set("sessionID", sessionID)

  const ws = new WebSocket(url.toString())
  const ready = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("ASR websocket error"))
  })

  ws.onmessage = (event) => {
    try {
      const raw = JSON.parse(String(event.data))
      if (raw?.type === "asr.partial") onAsr(Ws.AsrPartial.parse(raw))
      else if (raw?.type === "asr.final") onAsr(Ws.AsrFinal.parse(raw))
    } catch {
      // ignore
    }
  }

  return {
    ready,
    send(msg) {
      ready
        .then(() => ws.send(JSON.stringify(msg)))
        .catch(() => {})
    },
    close() {
      try {
        ws.close()
      } catch {
        // ignore
      }
    },
  }
}

