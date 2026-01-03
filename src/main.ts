import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import * as yaml from 'js-yaml';

type Octokit = ReturnType<typeof getOctokit>;
type Tag = Awaited<
  ReturnType<Octokit['rest']['repos']['listTags']>
>['data'][number];
type Commit = Awaited<
  ReturnType<Octokit['rest']['repos']['compareCommits']>
>['data']['commits'][number];

interface PubspecYaml {
  version: string;
}

interface ActionInputs {
  packageRoot: string;
  tagPrefix: string;
  tagSuffix: string;
  tagMessage: string;
  changelogStructure: string;
}

interface ActionOutputs {
  tagname: string;
  tagsha: string;
  taguri: string;
  tagmessage: string;
  tagref: string;
}

/**
 * Get required environment variables and validate them
 */
function getEnvironmentVariables(): {
  token: string;
  workspace: string;
  sha: string;
} {
  const token = process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }

  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) {
    throw new Error('GITHUB_WORKSPACE is not set');
  }

  const sha = process.env.GITHUB_SHA;
  if (!sha) {
    throw new Error('GITHUB_SHA is not set');
  }

  return { token, workspace, sha };
}

/**
 * Get all action inputs
 */
function getActionInputs(): ActionInputs {
  return {
    packageRoot: core.getInput('package_root', { required: false }) || './',
    tagPrefix: core.getInput('tag_prefix', { required: false }) || '',
    tagSuffix: core.getInput('tag_suffix', { required: false }) || '',
    tagMessage: core.getInput('tag_message', { required: false }).trim(),
    changelogStructure:
      core.getInput('changelog_structure', { required: false }) ||
      '**{{message}}** {{sha}})\n',
  };
}

/**
 * Set all action outputs
 */
function setActionOutputs(outputs: Partial<ActionOutputs>): void {
  const defaults: ActionOutputs = {
    tagname: '',
    tagsha: '',
    taguri: '',
    tagmessage: '',
    tagref: '',
  };

  const finalOutputs = { ...defaults, ...outputs };

  for (const [key, value] of Object.entries(finalOutputs)) {
    core.setOutput(key, value);
  }
}

/**
 * Load and parse pubspec.yaml file
 */
function loadPubspec(workspacePath: string, packageRoot: string): PubspecYaml {
  const pubspecPath = path.join(workspacePath, packageRoot, 'pubspec.yaml');

  core.debug(`Looking for pubspec.yaml at: ${pubspecPath}`);

  if (!fs.existsSync(pubspecPath)) {
    throw new Error(`pubspec.yaml does not exist at ${pubspecPath}`);
  }

  const fileContents = fs.readFileSync(pubspecPath, 'utf8');
  const parsed = yaml.load(fileContents) as unknown;

  if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
    throw new Error('Invalid pubspec.yaml: missing version field');
  }

  const pubspec = parsed as PubspecYaml;

  if (!pubspec.version || typeof pubspec.version !== 'string') {
    throw new Error('Invalid pubspec.yaml: version must be a non-empty string');
  }

  return pubspec;
}

/**
 * Fetch existing tags from the repository
 */
async function fetchExistingTags(
  github: Octokit,
  owner: string,
  repo: string,
): Promise<Tag[]> {
  try {
    const response = await github.rest.repos.listTags({
      owner,
      repo,
      per_page: 100,
    });
    return response.data;
  } catch (error) {
    core.debug(
      `No tags found: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Check if a tag already exists
 */
function tagExists(tags: Tag[], tagName: string): boolean {
  return tags.some((tag) => tag.name === tagName);
}

/**
 * Format a commit using the provided structure template
 */
function formatCommit(commit: Commit, structure: string): string {
  return structure.replace(
    /({{message}})|({{messageHeadline}})|({{author}})|({{sha}})/g,
    (match, message, messageHeadline, author, sha) => {
      if (message) return commit.commit.message;
      if (messageHeadline) return commit.commit.message.split('\n')[0];
      if (author) {
        return commit.author?.login ?? '';
      }
      if (sha) return commit.sha;
      return match;
    },
  );
}

/**
 * Generate changelog from commits between two references
 */
async function generateChangelog(
  github: Octokit,
  owner: string,
  repo: string,
  baseTag: string,
  headRef: string,
  structure: string,
): Promise<string> {
  const comparison = await github.rest.repos.compareCommits({
    owner,
    repo,
    base: baseTag,
    head: headRef,
  });

  return comparison.data.commits
    .map((commit) => formatCommit(commit, structure))
    .join('\n');
}

/**
 * Generate or use provided tag message
 */
async function getTagMessage(
  github: Octokit,
  owner: string,
  repo: string,
  providedMessage: string,
  existingTags: Tag[],
  changelogStructure: string,
  version: string,
): Promise<string> {
  // If a message is explicitly provided, use it
  if (providedMessage) {
    return providedMessage;
  }

  // If no tags exist, return default version message
  if (existingTags.length === 0) {
    return `Version ${version}`;
  }

  // Try to generate a changelog from the latest tag
  try {
    const latestTag = existingTags[0];
    const changelog = await generateChangelog(
      github,
      owner,
      repo,
      latestTag.name,
      'main',
      changelogStructure,
    );
    return changelog || `Version ${version}`;
  } catch (error) {
    core.warning(
      `Failed to generate changelog: ${error instanceof Error ? error.message : String(error)}`,
    );
    return `Version ${version}`;
  }
}

/**
 * Create a Git tag object
 */
async function createGitTag(
  github: Octokit,
  owner: string,
  repo: string,
  tagName: string,
  message: string,
  sha: string,
): Promise<string> {
  const response = await github.rest.git.createTag({
    owner,
    repo,
    tag: tagName,
    message,
    object: sha,
    type: 'commit',
  });

  core.info(`Created tag object: ${response.data.tag}`);
  return response.data.sha;
}

/**
 * Create a Git reference for the tag
 */
async function createGitReference(
  github: Octokit,
  owner: string,
  repo: string,
  tagName: string,
  sha: string,
): Promise<{ ref: string; url: string }> {
  const response = await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tagName}`,
    sha,
  });

  core.info(`Created reference: ${response.data.ref} at ${response.data.url}`);
  return {
    ref: response.data.ref,
    url: response.data.url,
  };
}

/**
 * Main function to create a tag
 */
async function createVersionTag(): Promise<void> {
  const { token, workspace, sha } = getEnvironmentVariables();
  const inputs = getActionInputs();

  // Load and validate pubspec
  const pubspec = loadPubspec(workspace, inputs.packageRoot);
  const version = pubspec.version;

  core.info(`Detected version: ${version}`);
  core.setOutput('version', version);

  // Initialize GitHub client
  const github = getOctokit(token);
  const { owner, repo } = context.repo;

  core.debug(`Repository: ${owner}/${repo}`);

  // Fetch existing tags
  const existingTags = await fetchExistingTags(github, owner, repo);

  // Generate full tag name
  const tagName = `${inputs.tagPrefix}${version}${inputs.tagSuffix}`;

  // Check if tag already exists
  if (tagExists(existingTags, tagName)) {
    core.warning(`Tag "${tagName}" already exists. Skipping tag creation.`);
    setActionOutputs({ tagname: '' });
    return;
  }

  // Generate tag message
  const tagMessage = await getTagMessage(
    github,
    owner,
    repo,
    inputs.tagMessage,
    existingTags,
    inputs.changelogStructure,
    version,
  );

  // Create the tag
  const tagSha = await createGitTag(
    github,
    owner,
    repo,
    tagName,
    tagMessage,
    sha,
  );

  // Create the reference
  const reference = await createGitReference(
    github,
    owner,
    repo,
    tagName,
    tagSha,
  );

  // Set outputs
  setActionOutputs({
    tagname: tagName,
    tagsha: tagSha,
    taguri: reference.url,
    tagmessage: tagMessage,
    tagref: reference.ref,
  });

  core.info(`Successfully created tag: ${tagName}`);
}

/**
 * Entry point
 */
async function run(): Promise<void> {
  try {
    await createVersionTag();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
    setActionOutputs({});
  }
}

void run();
