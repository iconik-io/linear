/* eslint-disable no-console */
import { LinearClient } from "@linear/sdk";
import chalk from "chalk";
import { format } from "date-fns";
import fs from "fs";
import * as inquirer from "inquirer";
import { Comment, Importer, ImportResult } from "./types";
import { replaceImagesInMarkdown } from "./utils/replaceImages";
const axios = require("axios");

interface ImportAnswers {
  newTeam: boolean;
  includeComments?: boolean;
  includeProject?: string;
  selfAssign?: boolean;
  targetAssignee?: string;
  targetProjectId?: boolean;
  targetTeamId?: string;
  teamName?: string;
}

const defaultStateColors = {
  backlog: "#bec2c8",
  started: "#f2c94c",
  completed: "#5e6ad2",
};

/**
 * Import issues into Linear via the API.
 */
export const importIssues = async (apiKey: string, importer: Importer): Promise<void> => {
  const client = new LinearClient({ apiKey });
  const importData = await importer.import();

  const teamsQuery = await client.teams();
  const viewerQuery = await client.viewer;
  const usersQuery = await client.users();

  const teams = teamsQuery?.nodes ?? [];
  const users = usersQuery?.nodes?.filter(user => user.active) ?? [];
  const viewer = viewerQuery?.id;

  // Prompt the user to either get or create a team
  const importAnswers = await inquirer.prompt<ImportAnswers>([
    {
      type: "confirm",
      name: "newTeam",
      message: "Do you want to create a new team for imported issues?",
      default: true,
    },
    {
      type: "input",
      name: "teamName",
      message: "Name of the team:",
      default: importer.defaultTeamName || importer.name,
      when: (answers: ImportAnswers) => {
        return answers.newTeam;
      },
    },
    {
      type: "list",
      name: "targetTeamId",
      message: "Import into team:",
      choices: async () => {
        return teams.map(team => ({
          name: `[${team.key}] ${team.name}`,
          value: team.id,
        }));
      },
      when: (answers: ImportAnswers) => {
        return !answers.newTeam;
      },
    },
    {
      type: "confirm",
      name: "includeProject",
      message: "Do you want to import to a specific project?",
      when: async (answers: ImportAnswers) => {
        // if no team is selected then don't show projects screen
        if (!answers.targetTeamId) {
          return false;
        }

        const team = await client.team(answers.targetTeamId);
        const teamProjects = await team?.projects();

        const projects = teamProjects?.nodes ?? [];
        return projects.length > 0;
      },
    },
    {
      type: "list",
      name: "targetProjectId",
      message: "Import into project:",
      choices: async (answers: ImportAnswers) => {
        // if no team is selected then don't show projects screen
        if (!answers.targetTeamId) {
          return false;
        }

        const team = await client.team(answers.targetTeamId);
        const teamProjects = await team?.projects();

        const projects = teamProjects?.nodes ?? [];
        return projects.map(project => ({
          name: project.name,
          value: project.id,
        }));
      },
      when: (answers: ImportAnswers) => {
        return answers.includeProject;
      },
    },
    {
      type: "confirm",
      name: "includeComments",
      message: "Do you want to include comments in the issue description?",
      when: () => {
        return !!importData.issues.find(issue => issue.comments && issue.comments.length > 0);
      },
    },
    {
      type: "confirm",
      name: "selfAssign",
      message: "Do you want to assign these issues to yourself?",
      default: true,
    },
    {
      type: "list",
      name: "targetAssignee",
      message: "Assign to user:",
      choices: () => {
        const map = users.map(user => ({
          name: user.name,
          value: user.id,
        }));
        map.push({ name: "[Unassigned]", value: "" });
        return map;
      },
      when: (answers: ImportAnswers) => {
        return !answers.selfAssign;
      },
    },
  ]);

  let teamKey: string | undefined;
  let teamId: string | undefined;
  if (importAnswers.newTeam) {
    // Create a new team
    const teamResponse = await client.createTeam({
      name: importAnswers.teamName as string,
    });
    const team = await teamResponse?.team;

    teamKey = team?.key;
    teamId = team?.id;
  } else {
    // Use existing team
    const existingTeam = teams?.find(team => team.id === importAnswers.targetTeamId);

    teamKey = existingTeam?.key;
    teamId = importAnswers.targetTeamId as string;
  }

  if (!teamId) {
    throw new Error("No team id found");
  }

  const teamInfo = await client.team(teamId);
  const organization = await client.organization;

  const issueLabels = await teamInfo?.labels();
  const organizationLabels = await organization.labels();
  const workflowStates = await teamInfo?.states();

  const existingLabelMap = {} as { [name: string]: string };
  const allLabels = (issueLabels.nodes ?? []).concat(organizationLabels.nodes);
  for (const label of allLabels) {
    const labelName = label.name?.toLowerCase();
    if (labelName && label.id && !existingLabelMap[labelName]) {
      existingLabelMap[labelName] = label.id;
    }
  }

  const projectId = importAnswers.targetProjectId;

  // Create labels and mapping to source data
  const labelMapping = {} as { [id: string]: string };
  for (const labelId of Object.keys(importData.labels)) {
    const label = importData.labels[labelId];
    const labelName = label.name;
    let actualLabelId = existingLabelMap[labelName.toLowerCase()];

    if (!actualLabelId) {
      console.log("Label", labelName, "not found. Creating");
      const labelResponse = await client
        .createIssueLabel({
          name: labelName,
          description: label.description,
          color: label.color,
        })
        .catch(() => {
          console.log("Unable to create label", labelName);
          return undefined;
        });

      const issueLabel = await labelResponse?.issueLabel;
      if (issueLabel?.id) {
        actualLabelId = issueLabel?.id;
      }
      existingLabelMap[labelName.toLowerCase()] = actualLabelId;
    }
    labelMapping[labelId] = actualLabelId;
  }

  const existingStateMap = {} as { [name: string]: string };
  for (const state of workflowStates?.nodes ?? []) {
    const stateName = state.name?.toLowerCase();
    if (stateName && state.id && !existingStateMap[stateName]) {
      existingStateMap[stateName] = state.id;
    }
  }

  const existingUserMap = {} as { [name: string]: string };
  for (const user of users) {
    const userName = user.name?.toLowerCase();
    if (userName && user.id && !existingUserMap[userName]) {
      existingUserMap[userName] = user.id;
    }
  }

  const originalIdmap = {} as { [name: string]: string };
  // Create issues
  for (const issue of importData.issues) {
    const issueDescription = issue.description;

    const description =
      importAnswers.includeComments && issue.comments
        ? await buildComments(client, issueDescription || "", issue.comments, importData)
        : issueDescription;

    const labelIds = issue.labels
      ? issue.labels.map(labelId => labelMapping[labelId]).filter(id => Boolean(id))
      : undefined;

    let stateId = !!issue.status ? existingStateMap[issue.status.toLowerCase()] : undefined;
    // Create a new state since one doesn't already exist with this name
    if (!stateId && issue.status) {
      let stateType = "backlog";
      if (issue.completedAt) {
        stateType = "completed";
      } else if (issue.startedAt) {
        stateType = "started";
      }
      const newStateResult = await client.createWorkflowState({
        name: issue.status,
        teamId,
        color: defaultStateColors[stateType],
        type: stateType,
      });
      if (newStateResult?.success) {
        const newState = await newStateResult.workflowState;
        if (newState?.id) {
          existingStateMap[issue.status.toLowerCase()] = newState.id;
          stateId = newState.id;
        }
      }
    }

    const existingAssigneeId: string | undefined = !!issue.assigneeId
      ? existingUserMap[issue.assigneeId.toLowerCase()]
      : undefined;

    const assigneeId: string | undefined =
      existingAssigneeId || importAnswers.selfAssign
        ? viewer
        : !!importAnswers.targetAssignee && importAnswers.targetAssignee.length > 0
        ? importAnswers.targetAssignee
        : undefined;

    const formattedDueDate = issue.dueDate ? format(issue.dueDate, "yyyy-MM-dd") : undefined;

    const newIssue = await client.createIssue({
      teamId,
      projectId: projectId as unknown as string,
      title: issue.title,
      description,
      priority: issue.priority,
      labelIds,
      stateId,
      assigneeId,
      dueDate: formattedDueDate,
    });
    const newId = (await newIssue.issue)?.id;
    console.log(JSON.stringify(newIssue));
    if (!!newId) {
      if (!!issue.originalId) {
        originalIdmap[issue.originalId] = newId;
        console.error(`Adding ${issue.originalId} to ${newId} `);
      }
      // if (!!issue.relatedOriginalIds) {
      //   for (const relatedId of issue.relatedOriginalIds) {
      //     console.error(`Checking ${relatedId}`);
      //     if (!!originalIdmap[relatedId]) {
      //       client.createIssueRelation({
      //         issueId: newId,
      //         relatedIssueId: originalIdmap[relatedId],
      //         type: IssueRelationType.Related,
      //       });
      //     }
      //   }
      // }
      //console.error(JSON.stringify(await client.issue(newId), null, 4));
      if (!!issue.url) {
        await client.attachmentLinkURL(newId, issue.url, { title: "Original Redmine issue" });
      }
      if (!!issue.extraUrls) {
        for (const url of issue.extraUrls) {
          await client.attachmentLinkURL(newId, url.url, !!url.title ? { title: url.title } : {});
        }
      }
      const files: string[] = [];
      const dir = `/tmp/redmineimporter/${issue.originalId}`;
      if (!!issue.originalId) {
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(file => {
            console.log(file);
            files.push(file);
          });
        }
      }
      if (files.length > 0) {
        let desc = description;
        let attachmentHeader = "# Attachments:\n\n";
        for (const file of files) {
          let contentType = "application/octet-stream";
          let isImage = "";
          if (file.toLowerCase().includes(".jpg")) {
            contentType = "image/jpg";
            isImage = "!";
          } else if (file.toLowerCase().includes(".png")) {
            contentType = "image/png";
            isImage = "!";
          }
          const stats = fs.statSync(dir + "/" + file);
          const fileSizeInBytes = stats.size;

          const uploadData = await client.fileUpload(contentType, file, fileSizeInBytes);
          console.log(`UPLOAD: ${JSON.stringify(uploadData)}`);
          const stream = fs.createReadStream(dir + "/" + file);
          const headers = {};
          for (const h of uploadData.uploadFile?.headers || []) {
            headers[h.key] = h.value;
          }
          headers["content-type"] = uploadData.uploadFile?.contentType;
          const upload = await axios({
            method: "put",
            url: uploadData.uploadFile?.uploadUrl,
            data: stream,
            headers: headers,
            maxBodyLength: 100_000_000,
          });
          console.log(`RESULT: ${upload.status}`);
          const issue = await client.issue(newId);
          console.log(JSON.stringify(issue));
          const imageString = `![](${file})`;
          if (desc?.includes(imageString)) {
            desc = desc.replace(imageString, `${isImage}[${file}](${uploadData.uploadFile?.assetUrl})`);
          } else {
            desc = desc + `\n${attachmentHeader}${isImage}[${file}](${uploadData.uploadFile?.assetUrl})\n`;
            attachmentHeader = "";
          }
          await client.updateIssue(newId, { description: desc });
        }
      }
    } else {
      console.error("No id on newly created issue");
    }
  }

  console.info(chalk.green(`${importer.name} issues imported to your team: https://linear.app/team/${teamKey}/all`));
};

// Build comments into issue description
const buildComments = async (
  client: LinearClient,
  description: string,
  comments: Comment[],
  importData: ImportResult
) => {
  const newComments: string[] = [];
  for (const comment of comments) {
    const user = importData.users[comment.userId];
    const date = comment.createdAt ? comment.createdAt.toISOString().split("T")[0] : undefined;

    const body = await replaceImagesInMarkdown(client, comment.body || "", importData.resourceURLSuffix);
    newComments.push(`**${user.name}**${" " + date}\n\n${body}\n`);
  }
  return `${description}\n\n---\n\n${newComments.join("\n\n")}`;
};
