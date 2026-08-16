import { z } from "zod";

export function optionalCredentialFreeHttpsUrlSchema({
  invalidMessage,
  httpsMessage,
  credentialsMessage,
  tooLongMessage,
}: {
  invalidMessage: string;
  httpsMessage: string;
  credentialsMessage: string;
  tooLongMessage: string;
}) {
  return z.string().superRefine((value, context) => {
    if (value === "") return;
    if (value.length > 2_048) {
      context.addIssue({ code: "custom", message: tooLongMessage });
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: invalidMessage });
      return;
    }
    if (url.protocol !== "https:") {
      context.addIssue({ code: "custom", message: httpsMessage });
    }
    if (url.hostname.length === 0) {
      context.addIssue({ code: "custom", message: invalidMessage });
    }
    if (url.username !== "" || url.password !== "") {
      context.addIssue({ code: "custom", message: credentialsMessage });
    }
  });
}
