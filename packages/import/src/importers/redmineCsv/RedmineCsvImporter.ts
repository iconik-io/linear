import csv from "csvtojson";
//import { roundToNearestMinutes } from "date-fns";
import { Importer, ImportResult } from "../../types";
// eslint-disable-next-line @typescript-eslint/no-var-requires

type RedmineStoryType = "Internal Bug" | "Internal Feature";

interface RedmineIssueType {
  "#": string;
  Subject: string;
  Tags: string;
  Iteration: string;
  "Iteration Start": string;
  "Iteration End": string;
  Tracker: RedmineStoryType;
  Priority: string;
  "Current State": string;
  "Created at": Date;
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

    const assignees = Array.from(new Set(data.map(row => row["Assignee"])));

    for (const user of assignees) {
      importData.users[user] = {
        name: user,
      };
    }

    for (const row of data) {
      const title = row.Subject;
      if (!title) {
        continue;
      }

      //const url = row.URL;
      const url = "https://redmine.iconik.biz/issues/" + row["#"];
      let pandoc = require('node-pandoc'),
        src = row.Description,
        args = '-f textile -t markdown';
      // Set your callback function
      const description :string = await new Promise((resolve, reject) => {
        pandoc(src, args, function(err: string, result: string): void {
          if (err) {
            reject(err)
            return;
          }
          resolve(result)
        })
      });
      // const priority = parseInt(row['Estimate']) ||  undefined;

      const tags = row.Tags.split(",");
      const categories = row["Category-Iconik"].split(",");
      const refs = row["Internal Reference"].split("\n");
      const extraUrls = [];
      if (!!refs) {
        for (const r of refs) {
          //console.error(r.trim());
          if (r.startsWith("http")) {
            if (r.includes("support.iconik.io")) {
              extraUrls.push({ url: r.trim(), title: "Zoho desk issue" });
            } else {
              extraUrls.push({ url: r.trim() });
            }
            //console.error(`Adding URL: ${r.trim()}`);
          }
        }
      }

      var priority = parseInt(row.Priority.substring(0,1))
      if (priority > 7) {
        priority = 1;
      } else if  (priority > 5) {
        priority = 2;
      } else if (priority > 3) {
        priority = 3;
      } else {
        priority = 4;
      }

      const assigneeId = row["Assignee"] && row["Assignee"].length > 0 ? row["Assignee"] : undefined;

      const status = row["Status"] && (row["Status"] === "Review" || row["Status"] === "Codereview") ? "Done" : "Todo";

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
      const createdAt = row["Created"];

      importData.issues.push({
        title,
        description,
        status,
        url,
        extraUrls,
        assigneeId,
        labels,
        createdAt,
        priority
      });

      for (const lab of labels) {
        if (!importData.labels[lab]) {
          importData.labels[lab] = {
            name: lab,
          };
        }
      }
    }

    return importData;
  };

  // -- Private interface

  private filePath: string;
}
