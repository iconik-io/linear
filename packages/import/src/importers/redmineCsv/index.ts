import * as inquirer from "inquirer";
import { Importer } from "../../types";
import { RedmineCsvImporter } from "./RedmineCsvImporter";

const BASE_PATH = process.cwd();

export const redmineCsvImport = async (): Promise<Importer> => {
  const answers = await inquirer.prompt<RedmineImportAnswers>(questions);
  const redmineImporter = new RedmineCsvImporter(answers.redmineFilePath);
  return redmineImporter;
};

interface RedmineImportAnswers {
  redmineFilePath: string;
}

const questions = [
  {
    basePath: BASE_PATH,
    type: "filePath",
    name: "redmineFilePath",
    message: "Select your exported CSV file of Redmine issues",
  },
];
