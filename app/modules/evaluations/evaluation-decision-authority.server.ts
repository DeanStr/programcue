export function decisionAuthorityGuardSql(eventIdExpression: string) {
  return `(
    ? IN ('owner','administrator')
    OR (
      ? = 'committee_chair'
      AND EXISTS (
        SELECT 1 FROM evaluation_plans authority_plan
         WHERE authority_plan.event_id = ${eventIdExpression}
           AND authority_plan.status = 'active'
           AND authority_plan.decision_role = 'committee_chair'
      )
    )
  )`;
}

export function decisionAuthorityBindings(role: string) {
  return [role, role] as const;
}
