import { useEffect } from "react";

export function usePublicProgrammeEmbedResize(
  embedded: boolean,
  eventSlug: string,
) {
  useEffect(() => {
    if (!embedded) return;
    let parentOrigin: string | null = null;
    const publishHeight = () => {
      if (!parentOrigin) return;
      window.parent.postMessage(
        {
          type: "programcue:resize",
          eventSlug,
          height: Math.ceil(document.documentElement.scrollHeight),
        },
        parentOrigin,
      );
    };
    const receiveHostOrigin = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source !== window.parent ||
        event.origin === "null" ||
        message?.type !== "programcue:host-origin" ||
        message.eventSlug !== eventSlug ||
        message.parentOrigin !== event.origin
      ) {
        return;
      }
      parentOrigin = event.origin;
      publishHeight();
    };
    window.addEventListener("message", receiveHostOrigin);
    const observer = new ResizeObserver(publishHeight);
    observer.observe(document.body);
    window.addEventListener("load", publishHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", receiveHostOrigin);
      window.removeEventListener("load", publishHeight);
    };
  }, [embedded, eventSlug]);
}
