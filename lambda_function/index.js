const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");

const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const { Jimp } = require("jimp");



const ENDPOINT_URL = process.env.AWS_ENDPOINT_URL || "http://localhost:4566";

const REGION = "us-east-1";



const s3 = new S3Client({

  endpoint: ENDPOINT_URL,

  region: REGION,

  forcePathStyle: true

});



const ddbClient = new DynamoDBClient({ endpoint: ENDPOINT_URL, region: REGION });

const docClient = DynamoDBDocumentClient.from(ddbClient);



const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB



exports.handler = async (event) => {

  const productoId = String(event.producto_id);

  const srcBucket = event.bucket;

  const srcKey = event.key;

  

  const dstBucket = "fotos-miniaturas";

  const dstKey = `miniaturas/${productoId}.png`;



  try {

    // 1. Obtener imagen desde S3

    const getCmd = new GetObjectCommand({ Bucket: srcBucket, Key: srcKey });

    const s3Response = await s3.send(getCmd);



    if (s3Response.ContentLength > MAX_SIZE_BYTES) {

      throw new Error(`El archivo excede los 5 MB permitidos (${s3Response.ContentLength} bytes)`);

    }



    // Convertir stream a Buffer

    const streamToBuffer = (stream) =>

      new Promise((resolve, reject) => {

        const chunks = [];

        stream.on("data", (chunk) => chunks.push(chunk));

        stream.on("error", reject);

        stream.on("end", () => resolve(Buffer.concat(chunks)));

      });



    const imageBuffer = await streamToBuffer(s3Response.Body);



    // 2. Leer imagen usando Jimp

    const image = await Jimp.read(imageBuffer);

    const mime = image.mime || "image/png";



    // 3. Redimensionar proporcionalmente a máximo 300x300

    image.resize({ w: 300 });

    const resizedBuffer = await image.getBuffer(mime);



    // 4. Guardar miniatura en S3

    await s3.send(

      new PutObjectCommand({

        Bucket: dstBucket,

        Key: dstKey,

        Body: resizedBuffer,

        ContentType: mime

      })

    );



    // 5. Actualizar en DynamoDB a estado LISTA

    await docClient.send(

      new UpdateCommand({

        TableName: "ProductosAtributos",

        Key: { producto_id: productoId },

        UpdateExpression: "SET estado_procesamiento = :st, miniatura_key = :mk, imagen_original_key = :ok",

        ExpressionAttributeValues: {

          ":st": "LISTA",

          ":mk": dstKey,

          ":ok": srcKey

        }

      })

    );



    return {

      statusCode: 200,

      body: JSON.stringify({

        mensaje: "Miniatura procesada exitosamente",

        producto_id: productoId,

        miniatura_key: dstKey,

        dimensiones: `${image.bitmap.width}x${image.bitmap.height}`

      })

    };



  } catch (err) {

    const errorMsg = err.message || "Error desconocido";



    try {

      await docClient.send(

        new UpdateCommand({

          TableName: "ProductosAtributos",

          Key: { producto_id: productoId },

          UpdateExpression: "SET estado_procesamiento = :st, error_mensaje = :err",

          ExpressionAttributeValues: {

            ":st": "ERROR",

            ":err": errorMsg

          }

        })

      );

    } catch (dbErr) {

      // Ignorar fallo secundario de BD

    }



    return {

      statusCode: 400,

      body: JSON.stringify({

        mensaje: "Error al procesar la imagen",

        error: errorMsg

      })

    };

  }

};
