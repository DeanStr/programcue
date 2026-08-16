import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ADMIN_SUBMISSION_PAGE_SIZE,
  type AdminSubmissionFilters,
} from "./submission-repository-shared";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";

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
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(page * ADMIN_SUBMISSION_PAGE_SIZE)
    ) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = ADMIN_SUBMISSION_PAGE_SIZE;
    const offset = (page - 1) * pageSize;
    const [rows, categories, matchingTotal, summary] = await Promise.all([
      this.repository.listAdminSubmissions(
        viewer.organisationId,
        viewer.eventId,
        filters,
        { limit: pageSize, offset },
      ),
      this.repository.listAdminSubmissionCategories(
        viewer.organisationId,
        viewer.eventId,
      ),
      this.repository.countAdminSubmissions(
        viewer.organisationId,
        viewer.eventId,
        filters,
      ),
      this.repository.getAdminSubmissionSummary(
        viewer.organisationId,
        viewer.eventId,
      ),
    ]);
    const totalPages = Math.max(1, Math.ceil(matchingTotal / pageSize));
    if (page > totalPages) {
      throw new Response(
        "This application result page no longer exists. Return to the first page and refresh the working set.",
        { status: 404 },
      );
    }
    return {
      summary,
      categories,
      results: {
        submissions: rows,
        matchingTotal,
        page,
        pageSize,
        firstItem: matchingTotal === 0 ? null : offset + 1,
        lastItem: matchingTotal === 0 ? null : offset + rows.length,
        totalPages,
      },
    };
  }

  async getAdminSubmissionQueueContext(
    viewer: Viewer,
    submissionId: string,
    filters: AdminSubmissionFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(page * ADMIN_SUBMISSION_PAGE_SIZE)
    ) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = ADMIN_SUBMISSION_PAGE_SIZE;
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
