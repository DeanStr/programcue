import { render, toPlainText } from "react-email";

import {
  ProgramCueEmail,
  type ProgramCueEmailProps,
} from "./program-cue-email";

export type RenderedEmail = { html: string; text: string };

export async function renderProgramCueEmail(
  props: ProgramCueEmailProps,
): Promise<RenderedEmail> {
  const html = await render(<ProgramCueEmail {...props} />);
  return { html, text: toPlainText(html) };
}
