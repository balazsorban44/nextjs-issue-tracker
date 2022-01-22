import type { NextApiRequest, NextApiResponse } from "next"

import { Octokit } from "octokit"
import { PrismaClientKnownRequestError } from "@prisma/client/runtime"

import { prisma } from "lib/prisma"
import { isoDate } from "utils"

interface TotalCountResult {
  repository: {
    totalOpened: {
      count: number
    }
    totalClosed: {
      count: number
    }
  }
}

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

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

    const data = await octokit.graphql<TotalCountResult>(
      `query {
        repository(owner: "vercel", name: "next.js") {
          totalOpened: issues(states: OPEN) {
            count: totalCount
          }
          totalClosed: issues(states: CLOSED) {
            count: totalCount
          }
        }
      }`
    )
    const result = await prisma.day.create({
      data: {
        date: isoDate(),
        totalOpened: data.repository.totalOpened.count,
        totalClosed: data.repository.totalClosed.count,
      },
    })

    return res.json(result)
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
