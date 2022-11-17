/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-explicit-any */
import csv from "csvtojson";
//import { roundToNearestMinutes } from "date-fns";
import { Comment, Importer, ImportResult } from "../../types";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require("https");
const fs = require("fs");

type RedmineStoryType = "Internal Bug" | "Internal Feature";

interface RedmineIssueType {
  Assignee: string;
  Status: string;
  "#": string;
  Subject: string;
  Tags: string;
  Iteration: string;
  "Iteration Start": string;
  "Iteration End": string;
  Tracker: RedmineStoryType;
  Priority: string;
  "Current State": string;
  Created: Date;
  "Accepted at": Date;
  "Category-Iconik": string;
  "Requested By": string;
  Description: string;
  URL: string;
  "Owned By": string;
  Blocker: string;
  "Blocker Status": string;
  Comment: string;
}

/**
 * Import issues from an Redmine Tracker CSV export.
 *
 * @param filePath  path to csv file
 * @param orgSlug   base Redmine project url
 */
export class RedmineCsvImporter implements Importer {
  public constructor(filePath: string) {
    this.filePath = filePath;
  }

  public get name(): string {
    return "Redmine (CSV)";
  }

  public get defaultTeamName(): string {
    return "Redmine";
  }

  public import = async (): Promise<ImportResult> => {
    const data = (await csv().fromFile(this.filePath)) as RedmineIssueType[];

    const importData: ImportResult = {
      issues: [],
      labels: {},
      users: {},
      statuses: {},
    };

    const assignees = Array.from(new Set(data.map(row => row.Assignee)));
    const users = new Set(assignees);

    const hostname = "https://redmine.iconik.biz";
    const config = {
      apiKey: "7db9d4d08352f61f80457e4d31a530de5dd2f1df",
      rejectUnauthorized: process.env.REJECT_UNAUTHORIZED,
    };

    for (const row of data) {
      const title = row.Subject;
      if (!title) {
        continue;
      }

      //const url = row.URL;
      const originalId = row["#"];
      let pandocSource = row.Description;
      const url = "https://redmine.iconik.biz/issues/" + originalId;
      if (row.Description?.startsWith("http")) {
        pandocSource = ".\n" + row.Description;
      }
      pandocSource += "\n\n";
      const pandoc = require("node-pandoc"),
        src = pandocSource,
        args = "-f textile -t markdown";
      // Set your callback function
      let description: string = await new Promise((resolve, reject) => {
        pandoc(src, args, function (err: string, result: string): void {
          if (err) {
            reject(err);
            return;
          }
          resolve(result);
        });
      });
      // const priority = parseInt(row['Estimate']) ||  undefined;
      const Redmine = require("axios-redmine");

      // protocol required in Hostname, supports both HTTP and HTTPS
      const redmine = new Redmine(hostname, config);
      const dumpIssue = function (issue: any) {
        console.log("Dumping issue:");
        for (const item in issue) {
          console.log("  " + item + ": " + JSON.stringify(issue[item]));
        }
      };
      const params = { include: "attachments,journals,watchers" };
      const response = await redmine.get_issue_by_id(parseInt(originalId), params).catch((err: unknown) => {
        console.log(err);
        return undefined;
      });
      if (response === undefined) {
        console.log("Skipping redmine issue:", originalId);
        continue;
      }

      await redmine
        .update_issue(parseInt(originalId), {
          issue: { custom_fields: [{ id: 56, name: "Exported to Linear", value: 1 }] },
        })
        .catch((err: unknown) => {
          console.log("Failed updating Exported to Linear field", err);
        });

      const attachments: any[] = response.data.issue.attachments.filter(
        (attachment: any) => attachment.filesize < 50000000
      );

      if (!!attachments && attachments.length > 0) {
        console.log(`Attachments2: ${JSON.stringify(attachments)}`);
        const dir = `/tmp/redmineimporter/${parseInt(originalId)}`;
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        for (const attachment of attachments) {
          const file = fs.createWriteStream(`${dir}/${attachment.filename}`);
          const request = https.get(
            attachment.content_url,
            { headers: { "X-Redmine-API-Key": config.apiKey } },
            function (response: any) {
              response.pipe(file);

              // after download completed close filestream
              file.on("finish", () => {
                file.close();
                // console.log("Download Completed");
              });
            }
          );
        }
      }

      const journals: any[] = response.data.issue.journals;
      const comments = journals
        .filter(journal => journal.notes !== undefined && journal.notes.length !== 0)
        .map(
          (journal: any): Comment => ({
            body: journal.notes,
            userId: journal.user.name,
            createdAt: new Date(journal.created_on),
          })
        );
      comments.forEach(({ userId }) => users.add(userId));

      const tags = row.Tags.split(",");
      const categories = row["Category-Iconik"].split(",");
      const refs = row["Internal Reference"].split(/[\n\s]/);
      const extraUrls = [];
      if (!!refs) {
        for (const r of refs) {
          //console.error(r.trim());
          if (r?.startsWith("http")) {
            if (r.includes("support.iconik.io")) {
              extraUrls.push({ url: r.trim(), title: "Zoho desk issue" });
            } else {
              extraUrls.push({ url: r.trim() });
            }
            //console.error(`Adding URL: ${r.trim()}`);
          }
        }
      }
      const relatedOriginalIds = [];
      const relatedIssues = row["Related issues"].split(",");
      if (!!relatedIssues) {
        for (const i of relatedIssues) {
          relatedOriginalIds.push(i.slice(1 + i.indexOf("#")));
        }
      }

      let priority = parseInt(row.Priority.substring(0, 1));
      if (priority > 7) {
        priority = 1;
      } else if (priority > 5) {
        priority = 2;
      } else if (priority > 3) {
        priority = 3;
      } else {
        priority = 4;
      }

      const assigneeId = row.Assignee && row.Assignee.length > 0 ? row.Assignee : undefined;

      const status = row.Status && (row.Status === "Review" || row.Status === "Codereview") ? "Done" : "Todo";

      let labels = tags.filter(tag => !!tag);
      if (row.Tracker === "Internal Bug") {
        labels.push("bug");
      }
      if (row.Tracker === "Internal Feature") {
        labels.push("feature");
      }
      if (!!categories) {
        labels = labels.concat(categories.filter(tag => !!tag));
      }
      const createdAt = row.Created;
      if (comments.length > 0) {
        description = description.concat("  \n  \n## Original Comments:\n");
      }
      // console.log(description);
      importData.issues.push({
        title,
        description,
        status,
        url,
        extraUrls,
        assigneeId,
        labels,
        createdAt,
        priority,
        originalId,
        relatedOriginalIds,
        comments,
      });

      for (const lab of labels) {
        if (!importData.labels[lab]) {
          importData.labels[lab] = {
            name: lab,
          };
        }
      }
    }

    for (const user of users) {
      importData.users[user] = { name: user };
    }

    return importData;
  };

  // -- Private interface

  private filePath: string;
}
