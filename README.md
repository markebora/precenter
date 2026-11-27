# Disciples PreCenter
Disciples PreCenter is free, open-source presentation software that eases the work of presenting
church services. Songs, Bible passages, announcements, timers, messages and media are all
in one place with simple navigation, with separate audience and stage screens, so worship teams
can run a service smoothly.

## Download

Get the latest Windows installer from the
[Releases page](https://github.com/markebora/precenter/releases/latest).

## Sign-in

* **Google (open to everyone):** choose **Continue with Google**. The first sign-in creates your account.
  It syncs the song database. Songs you save while signed in are shared with all PreCenter users.
* **Disciples team (invite only):** email accounts created by the project maintainers, for the team library,
  Harmony lineups and the Disciples phone remote. To request access,
  [open an issue](https://github.com/markebora/precenter/issues) and describe your team.
* **Guest:** works without an account.

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
