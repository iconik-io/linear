import { PluginFunction, PluginValidateFn, Types } from "@graphql-codegen/plugin-helpers";
import { DocumentMode } from "@graphql-codegen/visitor-plugin-common";
import { ContextVisitor, logger, nonNullable, PluginContext, printList } from "@linear/plugin-common";
import { GraphQLSchema, parse, printSchema, visit } from "graphql";
import { extname } from "path";
import { printOperations } from "./class";
import c from "./constants";
import { getSdkDefinitions } from "./definitions";
import { printModels } from "./model";
import { ModelVisitor } from "./model-visitor";
import { printRequest } from "./request";
import { RawSdkPluginConfig, SdkModel, SdkPluginContext } from "./types";

/**
 * Graphql-codegen plugin for outputting the typed Linear sdk
 */
export const plugin: PluginFunction<RawSdkPluginConfig> = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config: RawSdkPluginConfig
) => {
  try {
    logger.info("Parsing schema");
    const ast = parse(printSchema(schema));

    logger.info("Collecting context");
    const contextVisitor = new ContextVisitor(schema, config);
    visit(ast, contextVisitor);
    const context: PluginContext<RawSdkPluginConfig> = {
      ...contextVisitor.context,
      fragments: [],
    };

    logger.info("Generating models");
    const modelVisitor = new ModelVisitor(context);
    const models = visit(ast, modelVisitor) as SdkModel[];

    logger.info("Processing documents");
    const sdkDefinitions = getSdkDefinitions(context, documents, models);
    const sdkContext: SdkPluginContext = {
      ...context,
      models,
      sdkDefinitions,
    };

    logger.info("Printing models");
    const printedModels = printModels(sdkContext);

    logger.info("Printing operations");
    const printedOperations = printOperations(sdkContext);

    // /** Print each api definition  */
    // const printedDefinitions = Object.entries(sdkDefinitions).map(([apiKey, definition]) => {
    //   logger.info("Generating api", apiKey);

    //   return printSdkDefinition(sdkContext, definition);
    // });

    logger.info("Printing api");
    return {
      /** Add any initial imports */
      prepend: [
        /** Ignore unused variables */
        "/* eslint-disable @typescript-eslint/no-unused-vars */",
        /** Import DocumentNode if required */
        config.documentMode !== DocumentMode.string ? `import { DocumentNode } from 'graphql'` : undefined,
        /** Import document namespace */
        `import * as ${c.NAMESPACE_DOCUMENT} from '${config.documentFile}'`,
      ].filter(nonNullable),
      content: printList(
        [
          /** Print the requester function */
          printRequest(config),
          "\n",
          /** Print the query return types */
          printedModels,
          /** Print the api operations */
          printedOperations,
        ],
        "\n"
      ),
    };
  } catch (e) {
    logger.fatal(e);
    throw e;
  }
};

/**
 * Validate use of the plugin
 */
export const validate: PluginValidateFn = async (
  schema: GraphQLSchema,
  documents: Types.DocumentFile[],
  config: RawSdkPluginConfig,
  outputFile: string
) => {
  const packageName = "@linear/plugin-sdk";
  logger.info(`Validating ${packageName}`);
  logger.info({ config });

  const prefix = `Plugin "${packageName}" config requires`;

  if (extname(outputFile) !== ".ts") {
    throw new Error(`${prefix} output file extension to be ".ts" but is "${outputFile}"`);
  }

  if (!config.documentFile || typeof config.documentFile !== "string") {
    throw new Error(`${prefix} documentFile to be a string path to a document file generated by "typed-document-node"`);
  }
};
