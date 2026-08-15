import type { Viewer } from "~/platform/auth/authorize.server";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";
import type { AdminSubmissionFilters } from "./submission-repository-shared";

export class SubmissionAdministrationQueries extends SubmissionServiceFoundation {
  async listAdminSubmissions(viewer: Viewer, filters: AdminSubmissionFilters) {
    await this.airtable.assertReadable(viewer);
    return this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
    );
  }

  async listAdminSubmissionPage(
    viewer: Viewer,
    filters: AdminSubmissionFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = 50;
    const [rows, categories] = await Promise.all([
      this.repository.listAdminSubmissions(
        viewer.organisationId,
        viewer.eventId,
        filters,
        { limit: pageSize + 1, offset: (page - 1) * pageSize },
      ),
      this.repository.listAdminSubmissionCategories(
        viewer.organisationId,
        viewer.eventId,
      ),
    ]);
    return {
      submissions: rows.slice(0, pageSize),
      categories,
      page,
      hasNext: rows.length > pageSize,
    };
  }

  async getAdminSubmissionQueueContext(
    viewer: Viewer,
    submissionId: string,
    filters: AdminSubmissionFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = 50;
    const offset = Math.max(0, (page - 1) * pageSize - 1);
    const expectedPageStart = page === 1 ? 0 : 1;
    const rows = await this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
      {
        limit: page === 1 ? pageSize + 1 : pageSize + 2,
        offset,
      },
    );
    const currentIndex = rows.findIndex((row) => row.id === submissionId);
    if (
      currentIndex < expectedPageStart ||
      currentIndex >= expectedPageStart + pageSize
    ) {
      throw new Response(
        "The submission is no longer on the requested queue page. Return to the queue and refresh the working set.",
        { status: 409 },
      );
    }
    const neighbour = (index: number) => {
      const row = rows[index];
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        page: Math.floor((offset + index) / pageSize) + 1,
      };
    };
    return {
      previous: neighbour(currentIndex - 1),
      next: neighbour(currentIndex + 1),
    };
  }

  async getAdminSubmission(viewer: Viewer, submissionId: string) {
    await this.airtable.assertReadable(viewer);
    return this.repository.getAdminSubmission(
      viewer.organisationId,
      viewer.eventId,
      submissionId,
    );
  }
}
