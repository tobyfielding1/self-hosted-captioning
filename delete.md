# Remove live captions

This deletes the Google Cloud project the install created: the captioning server and everything in that project. It does **not** close your Soniox account or your Google billing account.

## Start

Click the **copy** button on the box below (it pastes into the terminal at the bottom of the screen), then press **Enter**. Use the church Google account.

```bash
git pull -q --ff-only; ./delete.sh
```

When it asks, type the project name and press **Enter**.

## What stays

The install never created these, so they stay until you close them yourself:

- **Soniox** — your account, remaining credit and autopay. [Delete the Soniox account](https://console.soniox.com/org/settings)
- **Google billing** — the billing account and card. [Close the Google billing account](https://console.cloud.google.com/billing) (pick the account, then **Account management** → **Close billing account**). Only do this if you created that billing account for captions and nothing else uses it.

The captions website on your computers still remembers the old links. They stop working. You can install again later if you want.
