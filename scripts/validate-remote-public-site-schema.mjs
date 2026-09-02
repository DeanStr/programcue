export function validateRemotePublicSiteSchema(input) {
  const {
    appliedMigrationNames,
    response,
    objects,
    publicSiteMigrationName,
    publicSiteRelationshipGuardMigrationName,
    publicSiteProgrammeMembershipGuardMigrationName,
    publicSpeakerConfirmationGuardMigrationName,
    speakerRelationshipIdentityGuardMigrationName,
    requiredPublicSiteColumns,
    requiredPublicSiteSchemaObjects,
    requiredFeaturedSpeakerRelationshipObjects,
    requiredSpeakerRelationshipIdentityObjects,
    requiredPublicSiteForeignKeys,
    successfulResults,
    validateColumns,
  } = input;
  const publicSiteApplied = appliedMigrationNames.includes(
    publicSiteMigrationName,
  );
  const featuredSpeakerRelationshipGuardsApplied =
    appliedMigrationNames.includes(publicSiteRelationshipGuardMigrationName);
  const programmeMembershipGuardsApplied = appliedMigrationNames.includes(
    publicSiteProgrammeMembershipGuardMigrationName,
  );
  const publicSpeakerConfirmationGuardsApplied = appliedMigrationNames.includes(
    publicSpeakerConfirmationGuardMigrationName,
  );
  const speakerRelationshipIdentityGuardsApplied =
    appliedMigrationNames.includes(
      speakerRelationshipIdentityGuardMigrationName,
    );
  if (featuredSpeakerRelationshipGuardsApplied && !publicSiteApplied) {
    throw new Error(
      "Remote D1 applied featured-speaker relationship guards without the public event-site baseline.",
    );
  }
  if (programmeMembershipGuardsApplied && !publicSiteApplied) {
    throw new Error(
      "Remote D1 aligned the featured-speaker session guard without the public event-site baseline.",
    );
  }
  if (
    publicSpeakerConfirmationGuardsApplied &&
    (!featuredSpeakerRelationshipGuardsApplied ||
      !programmeMembershipGuardsApplied)
  ) {
    throw new Error(
      "Remote D1 applied confirmed public-speaker eligibility without the featured-speaker relationship guards.",
    );
  }
  if (publicSiteApplied) {
    const publicSiteColumnRows = successfulResults(
      response[8],
      "public-site columns",
    );
    for (const [tableName, requiredColumns] of requiredPublicSiteColumns) {
      validateColumns(
        publicSiteColumnRows.filter((row) => row.tableName === tableName),
        requiredColumns,
        tableName,
      );
    }
    for (const [name, type] of requiredPublicSiteSchemaObjects) {
      if (objects.get(name) !== type) {
        throw new Error(`Remote D1 is missing required ${type} ${name}.`);
      }
    }
    const objectRows = successfulResults(response[2], "schema objects");
    const sponsorIndex = objectRows.find(
      (row) => row.name === "idx_event_site_sponsors_order",
    );
    if (
      typeof sponsorIndex?.sql !== "string" ||
      !/ON\s+event_site_sponsors\s*\(\s*event_id\s*,\s*tier\s*,\s*position\s*,\s*name\s*,\s*id\s*\)/iu.test(
        sponsorIndex.sql,
      )
    ) {
      throw new Error(
        "Remote D1 public-site sponsor index has the wrong ordering contract.",
      );
    }
    const recordingIndex = objectRows.find(
      (row) => row.name === "idx_event_session_recordings_public",
    );
    if (
      typeof recordingIndex?.sql !== "string" ||
      !/ON\s+event_session_recordings\s*\(\s*event_id\s*,\s*published_at\s*,\s*session_id\s*\)/iu.test(
        recordingIndex.sql,
      ) ||
      !/WHERE\s+published_at\s+IS\s+NOT\s+NULL/iu.test(recordingIndex.sql)
    ) {
      throw new Error(
        "Remote D1 public recording index is missing its published-row predicate.",
      );
    }
    const sessionTrigger = objectRows.find(
      (row) =>
        row.name === "prevent_referenced_public_session_eligibility_change",
    );
    const sessionTriggerSql =
      typeof sessionTrigger?.sql === "string" ? sessionTrigger.sql : "";
    const sessionTriggerHasBaseline =
      /BEFORE\s+UPDATE\s+OF\s+status\s*,\s*visibility\s+ON\s+sessions/iu.test(
        sessionTriggerSql,
      ) &&
      /event_public_site_references/iu.test(sessionTriggerSql) &&
      /event_session_recordings/iu.test(sessionTriggerSql) &&
      /NEW\.status\s*<>\s*'published'/iu.test(sessionTriggerSql) &&
      /NEW\.visibility\s*<>\s*'public'/iu.test(sessionTriggerSql) &&
      /reference\.kind\s*=\s*'session'/iu.test(sessionTriggerSql) &&
      /reference\.kind\s*=\s*'speaker'/iu.test(sessionTriggerSql) &&
      /recording\.published_at\s+IS\s+NOT\s+NULL/iu.test(sessionTriggerSql);
    const sessionTriggerMatchesLiveProgramme =
      publicSpeakerConfirmationGuardsApplied
        ? /session_id\s*<>\s*OLD\.id/iu.test(sessionTriggerSql) &&
          /profile_status\s*=\s*'published'/iu.test(sessionTriggerSql) &&
          /relation\.visibility\s*=\s*'public'/iu.test(sessionTriggerSql) &&
          /participation_status\s*=\s*'confirmed'/iu.test(sessionTriggerSql)
        : programmeMembershipGuardsApplied
          ? /session_id\s*<>\s*OLD\.id/iu.test(sessionTriggerSql) &&
            /profile_status\s*=\s*'published'/iu.test(sessionTriggerSql) &&
            /relation\.visibility\s*=\s*'public'/iu.test(sessionTriggerSql) &&
            !/participation_status\s*=\s*'confirmed'/iu.test(sessionTriggerSql)
          : /participation_status\s*=\s*'confirmed'/iu.test(
              sessionTriggerSql,
            ) && /content_status\s*=\s*'approved'/iu.test(sessionTriggerSql);
    if (!sessionTriggerHasBaseline || !sessionTriggerMatchesLiveProgramme) {
      throw new Error(
        "Remote D1 public-session eligibility trigger has the wrong protection contract.",
      );
    }
    const speakerTrigger = objectRows.find(
      (row) =>
        row.name === "prevent_referenced_public_speaker_profile_demotion",
    );
    if (
      typeof speakerTrigger?.sql !== "string" ||
      !/BEFORE\s+UPDATE\s+OF\s+profile_status\s+ON\s+people/iu.test(
        speakerTrigger.sql,
      ) ||
      !/event_public_site_references/iu.test(speakerTrigger.sql) ||
      !/reference\.kind\s*=\s*'speaker'/iu.test(speakerTrigger.sql) ||
      !/OLD\.profile_status\s*=\s*'published'/iu.test(speakerTrigger.sql) ||
      !/NEW\.profile_status\s*<>\s*'published'/iu.test(speakerTrigger.sql)
    ) {
      throw new Error(
        "Remote D1 featured-speaker profile trigger has the wrong protection contract.",
      );
    }
    if (featuredSpeakerRelationshipGuardsApplied) {
      for (const [name, type] of requiredFeaturedSpeakerRelationshipObjects) {
        if (objects.get(name) !== type) {
          throw new Error(`Remote D1 is missing required ${type} ${name}.`);
        }
      }
      const relationshipVisibilityTrigger = objectRows.find(
        (row) =>
          row.name ===
          "prevent_referenced_public_speaker_relationship_visibility_change",
      );
      const visibilityTriggerSql =
        typeof relationshipVisibilityTrigger?.sql === "string"
          ? relationshipVisibilityTrigger.sql
          : "";
      const visibilityTriggerMatchesContract =
        publicSpeakerConfirmationGuardsApplied
          ? /BEFORE\s+UPDATE\s+OF\s+visibility\s*,\s*participation_status\s+ON\s+session_speakers/iu.test(
              visibilityTriggerSql,
            ) &&
            /OLD\.participation_status\s*=\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            ) &&
            /NEW\.participation_status\s*<>\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            ) &&
            /alternative_relation\.participation_status\s*=\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            )
          : /BEFORE\s+UPDATE\s+OF\s+visibility\s+ON\s+session_speakers/iu.test(
              visibilityTriggerSql,
            );
      if (
        !visibilityTriggerMatchesContract ||
        !/event_public_site_references/iu.test(visibilityTriggerSql) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(visibilityTriggerSql) ||
        !/OLD\.visibility\s*=\s*'public'/iu.test(visibilityTriggerSql) ||
        !/NEW\.visibility\s*<>\s*'public'/iu.test(visibilityTriggerSql) ||
        !/session_id\s*<>\s*OLD\.session_id/iu.test(visibilityTriggerSql) ||
        !/RAISE\s*\(\s*ABORT\s*,/iu.test(visibilityTriggerSql)
      ) {
        throw new Error(
          "Remote D1 featured-speaker relationship visibility trigger has the wrong protection contract.",
        );
      }
      const relationshipDeleteTrigger = objectRows.find(
        (row) =>
          row.name === "prevent_referenced_public_speaker_relationship_delete",
      );
      const deleteTriggerSql =
        typeof relationshipDeleteTrigger?.sql === "string"
          ? relationshipDeleteTrigger.sql
          : "";
      const deleteTriggerMatchesConfirmation =
        !publicSpeakerConfirmationGuardsApplied ||
        (/OLD\.participation_status\s*=\s*'confirmed'/iu.test(
          deleteTriggerSql,
        ) &&
          /alternative_relation\.participation_status\s*=\s*'confirmed'/iu.test(
            deleteTriggerSql,
          ));
      if (
        !/BEFORE\s+DELETE\s+ON\s+session_speakers/iu.test(deleteTriggerSql) ||
        !/event_public_site_references/iu.test(deleteTriggerSql) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(deleteTriggerSql) ||
        !/OLD\.visibility\s*=\s*'public'/iu.test(deleteTriggerSql) ||
        !/session_id\s*<>\s*OLD\.session_id/iu.test(deleteTriggerSql) ||
        !/RAISE\s*\(\s*ABORT\s*,/iu.test(deleteTriggerSql) ||
        !deleteTriggerMatchesConfirmation
      ) {
        throw new Error(
          "Remote D1 featured-speaker relationship delete trigger has the wrong protection contract.",
        );
      }
    }
    if (speakerRelationshipIdentityGuardsApplied) {
      for (const [name, type] of requiredSpeakerRelationshipIdentityObjects) {
        if (objects.get(name) !== type) {
          throw new Error(`Remote D1 is missing required ${type} ${name}.`);
        }
      }
      const identityTrigger = objectRows.find(
        (row) => row.name === "session_speakers_identity_immutable",
      );
      const identityTriggerSql =
        typeof identityTrigger?.sql === "string" ? identityTrigger.sql : "";
      if (
        !/BEFORE\s+UPDATE\s+OF\s+event_id\s*,\s*session_id\s*,\s*person_id\s+ON\s+session_speakers/iu.test(
          identityTriggerSql,
        ) ||
        !/NEW\.event_id\s*<>\s*OLD\.event_id/iu.test(identityTriggerSql) ||
        !/NEW\.session_id\s*<>\s*OLD\.session_id/iu.test(identityTriggerSql) ||
        !/NEW\.person_id\s*<>\s*OLD\.person_id/iu.test(identityTriggerSql) ||
        !/NEW\.person_id\s+LIKE\s+'retained-participant-%'/iu.test(
          identityTriggerSql,
        ) ||
        !/profile_status\s*=\s*'archived'/iu.test(identityTriggerSql) ||
        !/retained\.id\s*=\s*NEW\.person_id/iu.test(identityTriggerSql) ||
        !/retained\.last_operation_id\s*=\s*event\.last_operation_id/iu.test(
          identityTriggerSql,
        ) ||
        !/event\.id\s*=\s*OLD\.event_id/iu.test(identityTriggerSql) ||
        !/participant_retention_completed_at\s+IS\s+NULL/iu.test(
          identityTriggerSql,
        ) ||
        !/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+event_public_site_references\s+reference/iu.test(
          identityTriggerSql,
        ) ||
        !/reference\.event_id\s*=\s*OLD\.event_id/iu.test(identityTriggerSql) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(identityTriggerSql) ||
        !/reference\.record_id\s*=\s*OLD\.person_id/iu.test(
          identityTriggerSql,
        ) ||
        !/RAISE\s*\(\s*ABORT\s*,\s*'Session speaker relationship identity is immutable'\s*\)/iu.test(
          identityTriggerSql,
        )
      ) {
        throw new Error(
          "Remote D1 session-speaker identity trigger has the wrong protection contract.",
        );
      }
    }
    const publicSiteForeignKeys = successfulResults(
      response[9],
      "public-site foreign keys",
    );
    const foreignKeyGroups = new Map();
    for (const row of publicSiteForeignKeys) {
      const key = JSON.stringify([row.tableName, row.id]);
      const group = foreignKeyGroups.get(key) ?? [];
      group.push(row);
      foreignKeyGroups.set(key, group);
    }
    for (const {
      tableName,
      targetTable,
      columns,
      onDelete,
    } of requiredPublicSiteForeignKeys) {
      if (
        ![...foreignKeyGroups.values()].some((unorderedRows) => {
          const rows = [...unorderedRows].sort(
            (left, right) => Number(left.seq) - Number(right.seq),
          );
          return (
            rows.length === columns.length &&
            rows.every(
              (row, index) =>
                row.tableName === tableName &&
                row.table === targetTable &&
                row.on_delete === onDelete &&
                row.seq === index &&
                row.from === columns[index][0] &&
                row.to === columns[index][1],
            )
          );
        })
      ) {
        throw new Error(
          `Remote D1 ${tableName} is missing its required foreign key (${columns.map(([from]) => from).join(", ")}) to ${targetTable} (${columns.map(([, to]) => to).join(", ")}).`,
        );
      }
    }
    const embedRows = successfulResults(response[10], "managed embed themes");
    if (embedRows.length !== 1 || embedRows[0]?.invalidCount !== 0) {
      throw new Error(
        "Remote D1 managed programme embeds retain a missing or invalid theme.",
      );
    }
  }

  return {
    publicSiteApplied,
    featuredSpeakerRelationshipGuardsApplied,
    publicSiteColumnCount: publicSiteApplied
      ? [...requiredPublicSiteColumns.values()].reduce(
          (count, columns) => count + columns.size,
          0,
        )
      : 0,
    publicSiteObjectCount: publicSiteApplied
      ? requiredPublicSiteSchemaObjects.size +
        (featuredSpeakerRelationshipGuardsApplied
          ? requiredFeaturedSpeakerRelationshipObjects.size
          : 0)
      : 0,
    publicSiteForeignKeyCount: publicSiteApplied
      ? requiredPublicSiteForeignKeys.length
      : 0,
  };
}
