# Disciples PreCenter

A free church presentation app for lyrics, songs and services, with a separate
audience output screen and stage screens. Runs on Windows.

## Download

Get the latest Windows installer from the
[Releases page](https://github.com/markebora/precenter/releases/latest).

## Sign-in (invite only)

Disciples PreCenter uses an online account to sign in, and to share the song library and settings
between the members of a team. Sign-in is by invitation only:

- Accounts are created by the project maintainers. There is no public sign-up.
- The sign-in and sync service runs on a free-tier Firebase project, which has limited capacity.
  Keeping accounts invite-only keeps the service reliable for the churches and teams already using it.
- To request access, [open an issue](https://github.com/markebora/precenter/issues) and describe your team.

### Running your own copy

The program is open source (GPL-3.0). Because the shared account service has limited capacity, other
churches and developers are encouraged to run the app with their own Firebase project and
their own accounts. The Firebase settings are read from the page's settings in
`precenter-desktop/app/index.html`; replace them with your own project's web configuration,
and set `siteUrl` in `config.json` to your own site. Your accounts, data and costs stay under your own control.

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

The installer is built from this repository by GitHub Actions.

## License

GPL-3.0. See [LICENSE](LICENSE).
