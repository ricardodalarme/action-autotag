const core = require('@actions/core');
const {GitHub, context} = require('@actions/github');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

async function setTagMessage(tagMsg, tags, github, owner, repo, changelogStructure, tagName) {
    let latestTag;
    if (tagMsg.length === 0 && tags.data.length > 0) {
        try {
            latestTag = tags.data.shift();

            let changelog = await github.repos.compareCommits({
                owner,
                repo,
                base: latestTag.name,
                head: 'main',
            });
            const structure = changelogStructure || `**{{message}}** {{sha}})\n`;

            tagMsg = changelog.data.commits
                .map(commit =>
                    structure
                        .replace(/({{message}})|({{messageHeadline}})|({{author}})|({{sha}})/g, (match, message, messageHeadline, author, sha) => {
                            if (message) return commit.commit.message;
                            if (messageHeadline) return commit.commit.message.split('\n')[0];
                            if (author) return !commit.hasOwnProperty('author') || !commit.author.hasOwnProperty('login') ? '' : commit.author.login;
                            if (sha) return commit.sha
                        }))
                .join('\n')
        } catch (e) {
            core.warning('Failed to generate changelog from commits: ' + e.message + os.EOL);
            tagMsg = tagName
        }
    }
    return tagMsg;
}

async function getExistingTag(github, owner, repo) {
    let tags = {data: []};
    try {
        tags = await github.repos.listTags({
            owner,
            repo,
            per_page: 100,
        })
    } catch (e) {
        core.debug(`No tag found`);
    }
    return tags;
}

function loadPubspec() {
    const dir = fs
        .readdirSync(path.resolve(process.env.GITHUB_WORKSPACE), {withFileTypes: true})
        .map(entry => {
            return `${entry.isDirectory() ? '> ' : '  - '}${entry.name}`
        })
        .join('\n');

    core.debug(` Working Directory: ${process.env.GITHUB_WORKSPACE}:\n${dir}`);

    if (!process.env.hasOwnProperty('GITHUB_TOKEN')) {
        if (!process.env.hasOwnProperty('INPUT_GITHUB_TOKEN')) {
            core.setFailed('Invalid or missing GITHUB_TOKEN.');
            return
        }
    }

    const pkg_root = core.getInput('package_root', {required: false});
    const pkgfile = path.join(process.env.GITHUB_WORKSPACE, pkg_root, 'pubspec.yaml');
    if (!fs.existsSync(pkgfile)) {
        core.setFailed('pubspec.yaml does not exist.');
        return
    }

    let fileContents = fs.readFileSync(pkgfile, 'utf8');
    return yaml.load(fileContents);

}

async function run() {
    try {
        core.debug(` Available environment variables:\n -> ${Object.keys(process.env)
            .map(i => i + ' :: ' + process.env[i])
            .join('\n -> ')}`);

        let pkg = loadPubspec();
        let version = pkg.version;
        core.setOutput('version', version);
        core.debug(` Detected version ${version}`);

        // Get authenticated GitHub client (Ocktokit): https://github.com/actions/toolkit/tree/master/packages/github#usage
        const github = new GitHub(process.env.GITHUB_TOKEN || process.env.INPUT_GITHUB_TOKEN);

        // Get owner and repo from context of payload that triggered the action
        const {owner, repo} = context.repo;

        // // Check for existing tag
        let tags = await getExistingTag(github, owner, repo);

        const tagPrefix = core.getInput('tag_prefix', {required: false});
        const tagSuffix = core.getInput('tag_suffix', {required: false});
        const changelogStructure = core.getInput('changelog_structure', {required: false});

        const getTagName = version => {
            return `${tagPrefix}${version}${tagSuffix}`
        };

        // Check for existance of tag and abort (short circuit) if it already exists.
        for (let tag of tags.data) {
            if (tag.name === getTagName(version)) {
                core.warning(`"${tag.name.trim()}" tag already exists.` + os.EOL);
                core.setOutput('tagname', '');
                return
            }
        }

        // Create the new tag name
        const tagName = getTagName(version);

        let tagMsg = core.getInput('tag_message', {required: false}).trim();
        tagMsg = await setTagMessage(tagMsg, tags, github, owner, repo, changelogStructure, tagName);

        let newTag;
        try {
            tagMsg = tagMsg.trim().length > 0 ? tagMsg : `Version ${version}`;

            newTag = await github.git.createTag({
                owner,
                repo,
                tag: tagName,
                message: tagMsg,
                object: process.env.GITHUB_SHA,
                type: 'commit'
            });

            core.warning(`Created new tag: ${newTag.data.tag}`)
        } catch (e) {
            core.setFailed(e.message);
            return
        }

        let newReference;
        try {
            newReference = await github.git.createRef({
                owner,
                repo,
                ref: `refs/tags/${newTag.data.tag}`,
                sha: newTag.data.sha,
            });

            core.warning(`Reference ${newReference.data.ref} available at ${newReference.data.url}` + os.EOL)
        } catch (e) {
            core.warning({
                owner,
                repo,
                ref: `refs/tags/${newTag.data.tag}`,
                sha: newTag.data.sha,
            });

            core.setFailed(e.message);
            return
        }

        // Store values for other actions
        if (typeof newTag === 'object' && typeof newReference === 'object') {
            core.setOutput('tagname', tagName);
            core.setOutput('tagsha', newTag.data.sha);
            core.setOutput('taguri', newReference.data.url);
            core.setOutput('tagmessage', tagMsg.trim());
            core.setOutput('tagref', newReference.data.ref)
        }
    } catch (error) {
        core.warning(error.message);
        core.setOutput('tagname', '');
        core.setOutput('tagsha', '');
        core.setOutput('taguri', '');
        core.setOutput('tagmessage', '');
        core.setOutput('tagref', '')
    }
}

run().then(r => core.debug('done!'));
