import type { NextApiRequest, NextApiResponse } from "next"
import type { Issue } from "types"

import { Octokit } from "octokit"

import { eachDayUntilToday, isoDate } from "utils"
import { prisma } from "lib/prisma"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime"

/**
 * git log --reverse --pretty --date=iso
 * Author: Guillermo Rauch
 * Date:   2016-10-05 16:35:00 -0700
 */
const FIRST_COMMIT_DATE = new Date("2016-10-05")

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    if (req.method !== "POST") {
      return res.status(405).end("Method not allowed")
    }

    if (process.env.SECRET !== req.body.secret) {
      return res.status(401).json({ message: "Unauthorized" })
    }

    const issues = await getIssues({
      owner: req.body.owner ?? "vercel",
      repo: req.body.repo ?? "next.js",
      hardLimitPage: req.body.page_limit ?? 2,
    })

    const dates = Object.fromEntries(
      eachDayUntilToday(FIRST_COMMIT_DATE).map((date) => {
        return [isoDate(date), { totalOpened: 0, totalClosed: 0 }]
      })
    )

    let openedAccumulator = 0
    let closedAccumulator = 0
    for (const date in dates) {
      const issuesOpened = issues.filter(
        (i) => isoDate(new Date(i.created_at)) === date
      )
      const issuesClosed = issues.filter(
        (i) => i.closed_at && isoDate(new Date(i.closed_at)) === date
      )

      closedAccumulator += issuesClosed.length

      if (issuesOpened.length) {
        openedAccumulator += issuesOpened.length
      }

      openedAccumulator -= issuesClosed.length
      dates[date].totalOpened += openedAccumulator
      dates[date].totalClosed += closedAccumulator
    }

    // http://localhost:3000/api/history?secret=SECRET&skip_save=1
    if (req.body.skip_save) {
      console.log("Skipping save")
    } else {
      console.log("Saving to database...")
      const datesEntries = Object.entries(dates)
      const datesPromises = datesEntries.map(([date, day]) => {
        return prisma.day.create({
          data: { date, ...day },
        })
      })
      await prisma.$transaction(datesPromises)
      console.log("Saved to database")
    }

    return res.json(dates)
  } catch (error) {
    console.error(error)
    if (
      error instanceof PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return res.status(400).json({ message: "Already exists" })
    }
    return res.status(500).json({ message: "Internal server error" })
  }
}
async function getIssues(options: {
  owner: string
  repo: string
  /**
   * Allow a maximum of this number of pages.
   * Useful when debugging to avoid exceeding GitHub API limits.
   * @default Infinity
   */
  hardLimitPage?: number
}) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
  const issues: Pick<Issue, "created_at" | "closed_at">[] = []

  let page = 1
  const hardLimit = options?.hardLimitPage ?? Infinity
  console.time("Fetching issues took")
  while (page <= hardLimit) {
    let issuesPage = await octokit.rest.issues
      .listForRepo({
        owner: options.owner,
        repo: options.repo,
        state: "all",
        per_page: 100,
        page,
      })
      .then((response) => response.data)
    if (issuesPage.length) {
      console.log(
        `Page ${page} with ${issuesPage.length} issues and pull requests fetched`
      )

      issuesPage = issuesPage.filter((i) => !i.pull_request)

      for (const issue of issuesPage) {
        // We don't care about pull requests
        // https://docs.github.com/en/rest/reference/issues#list-issues-assigned-to-the-authenticated-user
        if (issue.pull_request) continue

        issues.unshift({
          closed_at: issue.closed_at,
          created_at: issue.created_at,
        })
      }
      page += 1
    } else {
      console.log(
        `Reached last page: ${page - 1}, fetched ${issues.length} issues`
      )

      break
    }
  }
  console.timeEnd("Fetching issues took")

  return issues
}
