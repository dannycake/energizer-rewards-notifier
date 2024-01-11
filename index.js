import fs from "node:fs";
import path from "node:path";
import superagent from "superagent";
import chalk from "chalk";

const {
  Username: USERNAME,
  Password: PASSWORD,
  "Webhook URL": WEBHOOK_URL,
  "Items to watch": WATCHING_ITEMS,
  "Seconds between checks": CHECK_INTERVAL,
} = JSON.parse(fs.readFileSync(path.resolve("config.json"), "utf8"));

const account = {
  bearerToken: null,
  expiresAt: null,
  userId: null,

  applicationId: "SqPtY00vlTHivoukmX5XAAEipI9JaCa7",
  applicationSecret: "TUF1JqIMEZwkKS9wrnWaIQ5kSlE38c4WohT7O5MKgUaqOOSH",
};

const agent = new superagent.agent()
  .set(
    "user-agent",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0"
  )
  .set("x-pl-device", "Desktop")
  .set("x-pl-retailer", "Default");

const printColors = {
  info: "blueBright",
  warn: "yellowBright",
  error: "redBright",
  success: "greenBright",
  debug: "gray",
};
const print = (type, ...args) => {
  const time = chalk.yellowBright(new Date().toLocaleTimeString());

  if (!printColors[type]) throw new Error(`Unknown print type: ${type}`);

  return console.log(
    `[${time}] ${chalk[printColors[type]](`[${type.toUpperCase()}]`)}`,
    ...args
  );
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendDiscordWebhook = (data) => {
  superagent
    .post(WEBHOOK_URL)
    .set("content-type", "application/json")
    .send(data)
    .end();
};

const updateBearerToken = () =>
  new Promise((resolve) => {
    agent
      .post("https://energizerrewards.ebbo.com/auth/oauth2/token")
      .type("form")
      .send({
        grant_type: "password",
        client_id: account.applicationId,
        client_secret: account.applicationSecret,
        username: USERNAME,
        password: PASSWORD,
        response_type: "token",
      })
      .then((resp) => {
        const { access_token, expires_in, user_id } = resp.body;

        if (!access_token || !user_id) {
          print("error", "Failed to get access token:", resp.body);
          return resolve(false);
        }

        Object.assign(account, {
          bearerToken: `Bearer ${access_token}`,
          expiresAt: Date.now() + expires_in * 1000,
          userId: user_id,
        });

        resolve(true);
      })
      .catch((error) => {
        print(
          "error",
          "Failed to get access token:",
          error.response ? error.response.text : error
        );
        resolve(false);
      });
  });

const getStock = () =>
  new Promise((resolve) => {
    agent
      .post(
        `https://energizerrewards.ebbo.com/api/loyalty/${account.userId}/items`
      )
      .set("authorization", account.bearerToken)
      .send({
        page: 1,
        pageSize: 10000,
        categoryId: null,
        activeOnly: true,
      })
      .then((resp) => {
        const { Items: items } = resp.body;

        print(
          "success",
          `Fetched ${chalk.magentaBright(
            items.length
          )} items from Energizer Rewards`
        );

        return resolve(
          items
            .map((item) => {
              const {
                TotalRemaining: stock,
                Details: detailsArray,
                ItemStatus: status,
              } = item;

              const name = detailsArray
                .find((d) => d.Detail === "Name")
                .Value.replace(/(<([^>]+)>)/gi, "")
                .trim();

              const image = detailsArray.find(
                (d) => d.Detail === "Image"
              ).Value;

              return {
                name,
                stock,
                status,
                image,
              };
            })
            .filter((item) => WATCHING_ITEMS.includes(item.name))
        );
      })
      .catch((error) => {
        print(
          "error",
          "Failed to fetch current stock from Energizer Rewards:",
          error.response ? error.response.text : error
        );
        return resolve();
      });
  });

let previousStocks = null;

for (;;) {
  print("debug", "Checking Energizer Rewards stock...");

  if (!account.expiresAt || Date.now() > account.expiresAt) {
    if (!(await updateBearerToken())) {
      print(
        "error",
        `Failed to update bearer token, retrying in ${CHECK_INTERVAL} seconds...`
      );
      await sleep(CHECK_INTERVAL * 1000);
      continue;
    }

    print(
      "success",
      "Bearer token updated successfully, valid until",
      chalk.magentaBright(
        new Date(account.expiresAt).toLocaleTimeString("en-US")
      )
    );
  }

  const stock = await getStock();

  if (!previousStocks) {
    previousStocks = stock;

    print("debug", "Initial stock check complete, waiting for changes...");

    await sleep(CHECK_INTERVAL * 1000);
    continue;
  }

  const stockChanges = stock.filter((item) => {
    const previous = previousStocks.find((i) => i.name === item.name);
    return previous.stock < item.stock && previous.stock === 0;
  });

  const debugStockPrint = stock.map((item) => {
    const previous = previousStocks.find((i) => i.name === item.name);
    return `${chalk.gray("[*]")} ${chalk.magentaBright(item.name)}: ${
      previous.stock === 0
        ? chalk.redBright(previous.stock)
        : chalk.yellowBright(previous.stock)
    } -> ${
      item.stock === 0
        ? chalk.redBright(item.stock)
        : chalk.yellowBright(item.stock)
    }`;
  });
  print("debug", ["Current stock:", ...debugStockPrint].join("\n\t\t "));

  if (stockChanges.length) {
    let embedLines = [];

    for (const item of stockChanges) {
      print(
        "success",
        `Stock for ${chalk.magentaBright(
          item.name
        )} changed from ${chalk.yellowBright(
          previousStocks
            .find((i) => i.name === item.name)
            .stock.toLocaleString()
        )} to ${chalk.magentaBright(item.stock.toLocaleString())}`
      );

      embedLines.push(`**${item.name}** (\`${item.stock.toLocaleString()}\`)`);
    }

    sendDiscordWebhook({
      content: "@everyone",
      embeds: [
        {
          title: "Energizer Stock Update",
          description: embedLines.join("\n"),
          url: "https://energizergorewards.com/RewardStore",

          color: 0xff0070,

          thumbnail: {
            url: stockChanges.map((i) => i.image).filter(Boolean)[0],
          },
        },
      ],
    });
  }

  await sleep(CHECK_INTERVAL * 1000);
}
