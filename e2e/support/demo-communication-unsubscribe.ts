import { expect, type APIRequestContext } from "@playwright/test";

const fixturePath = "/demo/fixtures/communication-unsubscribe";
const confirmation = "manage-communication-unsubscribe-demo-fixture";
const sameOriginHeaders = { origin: "http://127.0.0.1:5173" };

export type DemoCommunicationUnsubscribeFixture = {
  unsubscribePath: string;
  statePath: string;
  address: string;
  category: string;
  count: number;
  reason: string | null;
  revokedAt: number | null;
};

export async function seedDemoCommunicationUnsubscribe(
  request: APIRequestContext,
): Promise<DemoCommunicationUnsubscribeFixture> {
  const response = await request.post(fixturePath, {
    form: { confirm: confirmation, intent: "seed" },
    headers: sameOriginHeaders,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<DemoCommunicationUnsubscribeFixture>;
}

export async function readDemoCommunicationUnsubscribe(
  request: APIRequestContext,
  fixture: DemoCommunicationUnsubscribeFixture,
) {
  const response = await request.get(fixture.statePath);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<DemoCommunicationUnsubscribeFixture>;
}

export async function clearDemoCommunicationUnsubscribe(request: APIRequestContext) {
  const response = await request.post(fixturePath, {
    form: { confirm: confirmation, intent: "clear" },
    headers: sameOriginHeaders,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
