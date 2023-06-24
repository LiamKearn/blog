import * as cdk from 'aws-cdk-lib';
import { CfnParameter, RemovalPolicy } from 'aws-cdk-lib';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Distribution, HttpVersion, PriceClass, ViewerProtocolPolicy, GeoRestriction } from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  ARecord,
  PublicHostedZone,
  RecordTarget,
} from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import {
  BlockPublicAccess,
  Bucket,
  RedirectProtocol,
} from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export class BlogStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const HostedZoneIDParam = new CfnParameter(this, 'HostedZoneID', {
      type: 'String',
      description: 'The Hosted Zone ID to spin up the content on.',
    });
    const HostedZoneNameParam = new CfnParameter(this, 'HostedZoneName', {
      type: 'String',
      description: 'The Hosted Zone Name to spin up the content on.',
    });
    const CertARN = new CfnParameter(this, 'CertARN', {
      type: 'String',
      description: 'ARN of ACM cert to use (must be us-east-1).',
    });

    const PrimaryZone = PublicHostedZone.fromHostedZoneAttributes(
      this,
      'PrimaryZone',
      {
        hostedZoneId: HostedZoneIDParam.valueAsString,
        zoneName: HostedZoneNameParam.valueAsString,
      }
    );

    const AllowPublicAccess = new BlockPublicAccess({
      blockPublicAcls: false,
      blockPublicPolicy: false,
      ignorePublicAcls: false,
      restrictPublicBuckets: false,
    });

    const LoggingBucket = new Bucket(this, 'LoggingBucket', {
      bucketName: `${PrimaryZone.zoneName}-logging`,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const RootDomainBucket = new Bucket(this, 'RootDomainBucket', {
      blockPublicAccess: AllowPublicAccess,
      bucketName: PrimaryZone.zoneName,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'error.html',
    });

    RootDomainBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'PublicReadGetObject',
        effect: Effect.ALLOW,
        // Completely public bucket.
        principals: [new AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [`${RootDomainBucket.bucketArn}/*`],
      })
    );

    new BucketDeployment(this, 'ContentDeploymeny', {
      destinationBucket: RootDomainBucket,
      sources: [Source.asset('./content')],
    });

    const WWWDomainBucket = new Bucket(this, 'WWWDomainBucket', {
      bucketName: `www.${PrimaryZone.zoneName}`,
      websiteRedirect: {
        hostName: RootDomainBucket.bucketWebsiteUrl,
        protocol: RedirectProtocol.HTTP,
      },
    });

    // TODO for some reason these have to be in us-east-1. Maybe out why.
    // SEE: node_modules/@aws-cdk/aws-cloudfront/lib/distribution.js:36
    const cert = Certificate.fromCertificateArn(
      this,
      'MainCert',
      CertARN.valueAsString
    );
    const BlogFrontDistrobution = new Distribution(this, 'BlogFrontDistrobution', {
      comment: 'Main cloud front distrobution for the blog',
      certificate: cert,
      defaultBehavior: {
        origin: new S3Origin(RootDomainBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      priceClass: PriceClass.PRICE_CLASS_ALL,
      domainNames: [`www.${PrimaryZone.zoneName}`, PrimaryZone.zoneName],
      defaultRootObject: 'index.html',
      enableLogging: true,
      logBucket: LoggingBucket,
      logFilePrefix: 'cflogs',
      httpVersion: HttpVersion.HTTP2_AND_3,
      // Have thousands of testing requests but no actual traffic to index.html from theses countries.
      geoRestriction: GeoRestriction.denylist('HK', 'CN', 'KP', 'RU')
    });

    for (const [name, bucket] of Object.entries({
      RootDomainBucket: RootDomainBucket,
      WWWDomainBucket: WWWDomainBucket,
    })) {
      new ARecord(this, `${name}ADirection`, {
        // This is prefixed to the zoneName eg. www-(prefixed to)-.liamkearn.me
        recordName: name === 'WWWDomainBucket' ? 'www' : undefined,
        zone: PrimaryZone,
        // FIXME this currently requires the region to be specific but in CFN
        // you can use a FN::fromMap etc to make this region agnostic.
        target: RecordTarget.fromAlias(new CloudFrontTarget(BlogFrontDistrobution)),
        comment: `Route lookups from ${PrimaryZone.zoneName} to ${bucket.bucketName}`,
      });
    }
  }
}
